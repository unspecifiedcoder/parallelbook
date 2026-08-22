// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title MathUp
/// @notice Rounding helpers. The direction of rounding is a solvency decision here,
///         not a style choice, so both directions are named explicitly.
library MathUp {
    /// @dev Round UP. Use for every collateral DEBIT. The protocol must never be
    ///      short a matched pair. Rounding down here is an insolvency bug.
    function mulDivUp(uint256 a, uint256 b, uint256 d) internal pure returns (uint256) {
        return (a * b + d - 1) / d;
    }

    /// @dev Round DOWN. Use for every collateral CREDIT (payouts, void refunds).
    ///      Surplus dust stays in the contract; a deficit would be a bug.
    function mulDivDown(uint256 a, uint256 b, uint256 d) internal pure returns (uint256) {
        return (a * b) / d;
    }
}

/// @title Market — one short-dated binary prediction market, sharded by price tick
/// @author LiveMarkets
/// @notice PARALLELISM CONTRACT: every state-changing function touches at most
///         (a) storage keyed by ONE tick, and (b) storage keyed by msg.sender.
///         Two transactions on different ticks share no slot and can execute
///         concurrently on Monad's parallel executor.
///
///         Do NOT add any global counter, global array, or aggregate total that is
///         WRITTEN on a hot path. A single shared written slot serialises the entire
///         book and destroys the only interesting property this contract has.
///
///         Globals that are written once at construction and only ever READ
///         afterwards (question, resolver, feeBps, openUntil...) are fine: reads
///         never conflict with reads.
contract Market {
    using MathUp for uint256;

    // ---------------------------------------------------------------- types

    enum Phase {
        Open, // orders accepted, matching allowed
        Locked, // no new orders, matching still allowed, refunds allowed
        Resolved // outcome known, matching frozen, claims open
    }

    enum Outcome {
        Unresolved,
        Yes,
        No,
        Void
    }

    /// @dev One price level. Four storage slots, all keyed by the tick id.
    ///      This struct is the shard.
    struct Tick {
        uint128 openYes; // unfilled YES shares
        uint128 openNo; // unfilled NO shares
        uint128 matched; // matched pairs, in shares
        uint128 feeAcc; // protocol fee accrued at this tick, in collateral
        uint128 crankAcc; // crank reward accrued at this tick, in collateral
        uint32 yesCursor; // next YES order index to visit
        uint32 noCursor; // next NO order index to visit
        address cranker; // last address that did useful matching work here
    }

    struct Order {
        address maker;
        uint128 shares;
        uint128 filled;
        uint128 paid; // exact collateral taken — makes refunds exact
        bool withdrawn;
    }

    // ------------------------------------------------------------ constants

    uint256 public constant ONE = 10_000; // 1.00 in basis points
    uint256 public constant TICK_STEP = 500; // 0.05
    uint8 public constant NUM_TICKS = 19; // 0.05 .. 0.95
    uint128 public constant MIN_SHARES = 1e15; // anti-dust: 0.001 shares
    uint32 public constant AUTO_MATCH_STEPS = 8; // opportunistic fill inside place()

    // -------------------------------------------------------------- storage

    // Written once in the constructor, read-only forever after.
    string public question;
    address public resolver;
    address public feeRecipient;
    uint16 public feeBps; // fee on winnings, out of ONE. 100 = 1%
    uint16 public crankShareBps; // slice OF THE FEE paid to the cranker, out of ONE
    uint64 public openUntil;
    uint64 public resolveAfter;

    // The only global written after construction. Written at most twice in the
    // life of the market (pause / resolve), never on a hot path.
    Outcome public outcome;
    bool public tradingPaused;

    // Sharded state. Everything below is keyed by tick and/or by address.
    mapping(uint8 => Tick) private _ticks;
    mapping(uint8 => Order[]) public yesOrders;
    mapping(uint8 => Order[]) public noOrders;

    mapping(uint8 => mapping(address => uint128)) public yesPos;
    mapping(uint8 => mapping(address => uint128)) public noPos;
    mapping(address => uint256) public balance;

    // --------------------------------------------------------------- events

    event Deposited(address indexed who, uint256 amount);
    event Withdrawn(address indexed who, uint256 amount);
    event OrderPlaced(
        uint8 indexed tick, bool isYes, uint32 index, address indexed maker, uint128 shares, uint256 cost
    );
    event OrderWithdrawn(
        uint8 indexed tick, bool isYes, uint32 index, address indexed maker, uint128 shares, uint256 refund
    );
    event Matched(uint8 indexed tick, uint128 shares, uint128 tickTotal, address indexed matcher);
    event Resolved(Outcome outcome);
    event Claimed(address indexed who, uint256 net, uint256 fee);
    event TradingPaused(bool paused);
    event FeesSwept(address indexed to, uint256 amount);
    event CrankRewardPaid(uint8 indexed tick, address indexed to, uint256 amount);

    // --------------------------------------------------------------- errors

    error NotOpen();
    error TooEarly();
    error NotResolved();
    error AlreadyResolved();
    error BadTick();
    error TooSmall();
    error NotYours();
    error NoBalance();
    error TransferFailed();
    error Paused();

    // ---------------------------------------------------------- constructor

    constructor(
        string memory _question,
        address _resolver,
        address _feeRecipient,
        uint16 _feeBps,
        uint16 _crankShareBps,
        uint64 _openSeconds,
        uint64 _resolveSeconds
    ) {
        require(_resolver != address(0) && _feeRecipient != address(0), "zero addr");
        require(_feeBps <= 500, "fee too high"); // hard cap 5%
        require(_crankShareBps <= ONE, "bad crank share");
        require(_resolveSeconds >= _openSeconds, "bad window");

        question = _question;
        resolver = _resolver;
        feeRecipient = _feeRecipient;
        feeBps = _feeBps;
        crankShareBps = _crankShareBps;
        openUntil = uint64(block.timestamp) + _openSeconds;
        resolveAfter = uint64(block.timestamp) + _resolveSeconds;
    }

    // ------------------------------------------------------------- pricing

    /// @notice Price of the YES leg at `tick`, in basis points. 500..9500.
    function price(uint8 tick) public pure returns (uint256) {
        if (tick >= NUM_TICKS) revert BadTick();
        return (uint256(tick) + 1) * TICK_STEP;
    }

    /// @notice Price of one leg. The two legs of a tick always sum to ONE.
    function legPrice(uint8 tick, bool isYes) public pure returns (uint256) {
        uint256 p = price(tick);
        return isYes ? p : ONE - p;
    }

    /// @notice Exact collateral required for `shares` of one leg. Rounds UP.
    function cost(uint8 tick, uint128 shares, bool isYes) public pure returns (uint256) {
        return uint256(shares).mulDivUp(legPrice(tick, isYes), ONE);
    }

    function phase() public view returns (Phase) {
        if (outcome != Outcome.Unresolved) return Phase.Resolved;
        return block.timestamp < openUntil ? Phase.Open : Phase.Locked;
    }

    // ---------------------------------------------------------- collateral

    function deposit() public payable {
        balance[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        if (balance[msg.sender] < amount) revert NoBalance();
        balance[msg.sender] -= amount; // state before call
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    // ------------------------------------------------------------- trading

    /// @notice Place a limit order for `shares` at `tick`, then opportunistically
    ///         match a few steps so the order can fill in the same transaction.
    /// @dev Writes: _ticks[tick], (yes|no)Orders[tick], (yes|no)Pos[tick][*],
    ///      balance[msg.sender]. Nothing else. Still one tick, still parallel.
    function place(uint8 tick, uint128 shares, bool isYes) external payable returns (uint32 index) {
        if (tradingPaused) revert Paused();
        if (phase() != Phase.Open) revert NotOpen();
        if (shares < MIN_SHARES) revert TooSmall();
        if (msg.value > 0) deposit();

        uint256 c = cost(tick, shares, isYes); // reverts on bad tick
        if (balance[msg.sender] < c) revert NoBalance();
        balance[msg.sender] -= c;

        Tick storage t = _ticks[tick];
        Order memory o = Order(msg.sender, shares, 0, uint128(c), false);

        if (isYes) {
            index = uint32(yesOrders[tick].length);
            yesOrders[tick].push(o);
            t.openYes += shares;
        } else {
            index = uint32(noOrders[tick].length);
            noOrders[tick].push(o);
            t.openNo += shares;
        }

        emit OrderPlaced(tick, isYes, index, msg.sender, shares, c);

        // Taker-ish behaviour: if the other side is already resting here, fill now.
        // Same storage footprint as the order itself, so this costs no parallelism.
        if (t.openYes > 0 && t.openNo > 0) _matchTick(tick, AUTO_MATCH_STEPS);
    }

    /// @notice Match YES against NO at one tick, FIFO, bounded work.
    /// @dev Permissionless — anyone can crank. The cranker calls this for all 19
    ///      ticks concurrently; that concurrency IS the product's core claim.
    ///      Cursors mean work is never repeated: the loop never restarts at 0.
    function matchTick(uint8 tick, uint32 maxSteps) public returns (uint128 filledTotal) {
        if (tick >= NUM_TICKS) revert BadTick();
        // Matching after the outcome is known would let anyone hand themselves a
        // winning position out of a resting order. Freeze it.
        if (outcome != Outcome.Unresolved) revert AlreadyResolved();
        return _matchTick(tick, maxSteps);
    }

    /// @dev Fill one resting YES order against one resting NO order, and credit
    ///      both makers. Split out of the matching loop on purpose: holding the
    ///      tick struct, both order arrays, both cursors, the step counter and
    ///      both order pointers live at once overflows the EVM's 16-slot stack,
    ///      and the contract does not compile without via-ir. Keeping the pair
    ///      fill in its own frame is cheaper than turning via-ir on for the whole
    ///      project. Writes stay inside tick `tick` -- the parallelism contract
    ///      at the top of this file still holds.
    function _fillPair(uint8 tick, Order storage yo, Order storage no_) private returns (uint128 fill) {
        uint128 yRem = yo.shares - yo.filled;
        uint128 nRem = no_.shares - no_.filled;
        fill = yRem < nRem ? yRem : nRem;

        yo.filled += fill;
        no_.filled += fill;

        yesPos[tick][yo.maker] += fill;
        noPos[tick][no_.maker] += fill;
    }

    function _matchTick(uint8 tick, uint32 maxSteps) internal returns (uint128 filledTotal) {
        Order[] storage ys = yesOrders[tick];
        Order[] storage ns = noOrders[tick];

        uint32 y = _ticks[tick].yesCursor;
        uint32 n = _ticks[tick].noCursor;
        uint32 steps;

        while (steps < maxSteps && y < ys.length && n < ns.length) {
            if (ys[y].withdrawn || ys[y].filled == ys[y].shares) {
                ++y;
                ++steps;
                continue;
            }
            if (ns[n].withdrawn || ns[n].filled == ns[n].shares) {
                ++n;
                ++steps;
                continue;
            }

            filledTotal += _fillPair(tick, ys[y], ns[n]);
            ++steps;
        }

        Tick storage t = _ticks[tick];
        t.yesCursor = y;
        t.noCursor = n;

        // Aggregated after the loop rather than per fill. Every fill decrements
        // openYes and openNo by the same amount and raises matched by it, so the
        // running totals are identical -- but this is three SSTOREs per call
        // instead of three per matched pair.
        if (filledTotal > 0) {
            t.openYes -= filledTotal;
            t.openNo -= filledTotal;
            t.matched += filledTotal;
            t.cranker = msg.sender;
            emit Matched(tick, filledTotal, t.matched, msg.sender);
        }
    }

    /// @notice Crank several ticks in one transaction. Convenience for wallets;
    ///         the production cranker sends one tx per tick so they run in parallel.
    function matchTicks(uint8[] calldata tickList, uint32 maxSteps) external returns (uint128 total) {
        for (uint256 i; i < tickList.length; ++i) {
            total += matchTick(tickList[i], maxSteps);
        }
    }

    /// @notice Reclaim the collateral behind the unfilled part of your order.
    /// @dev Acts as a cancel while Open, and as a refund once Locked. One function,
    ///      both jobs. Refund is exact because `paid` is stored rather than recomputed.
    function withdrawOrder(uint8 tick, bool isYes, uint32 index) external returns (uint256 refund) {
        Order storage o = isYes ? yesOrders[tick][index] : noOrders[tick][index];
        if (o.maker != msg.sender) revert NotYours();
        if (o.withdrawn) revert NotYours();

        uint128 rem = o.shares - o.filled;
        o.withdrawn = true;

        if (rem > 0) {
            Tick storage t = _ticks[tick];
            if (isYes) t.openYes -= rem;
            else t.openNo -= rem;

            // cannot underflow: mulDivUp is monotonic in `shares`
            uint256 usedForFilled = uint256(o.filled).mulDivUp(legPrice(tick, isYes), ONE);
            refund = uint256(o.paid) - usedForFilled;
            balance[msg.sender] += refund;
        }

        emit OrderWithdrawn(tick, isYes, index, msg.sender, rem, refund);
    }

    /// @notice Cancel every open order the caller has at a tick, in one call.
    function withdrawOrdersAt(uint8 tick, bool isYes) external returns (uint256 refund) {
        Order[] storage arr = isYes ? yesOrders[tick] : noOrders[tick];
        Tick storage t = _ticks[tick];
        uint256 len = arr.length;
        for (uint256 i; i < len; ++i) {
            Order storage o = arr[i];
            if (o.maker != msg.sender || o.withdrawn) continue;
            uint128 rem = o.shares - o.filled;
            o.withdrawn = true;
            if (rem == 0) continue;
            if (isYes) t.openYes -= rem;
            else t.openNo -= rem;
            uint256 usedForFilled = uint256(o.filled).mulDivUp(legPrice(tick, isYes), ONE);
            uint256 r = uint256(o.paid) - usedForFilled;
            refund += r;
            emit OrderWithdrawn(tick, isYes, uint32(i), msg.sender, rem, r);
        }
        if (refund > 0) balance[msg.sender] += refund;
    }

    // ---------------------------------------------------------- resolution

    function resolve(Outcome o) external {
        if (msg.sender != resolver) revert NotYours();
        if (block.timestamp < resolveAfter) revert TooEarly();
        if (outcome != Outcome.Unresolved) revert AlreadyResolved();
        if (o == Outcome.Unresolved) revert AlreadyResolved();
        outcome = o;
        emit Resolved(o);
    }

    /// @notice Kill switch. Blocks NEW orders only. Never blocks withdrawOrder,
    ///         claim, or withdraw — a pause that traps user funds is worse than
    ///         no pause at all.
    function setTradingPaused(bool p) external {
        if (msg.sender != resolver) revert NotYours();
        tradingPaused = p;
        emit TradingPaused(p);
    }

    /// @notice Collect winnings. Touches only msg.sender's slots and the fee
    ///         accumulator of each tick claimed, so two users claiming different
    ///         ticks never conflict.
    function claim(uint8[] memory tickList) public returns (uint256 net) {
        if (outcome == Outcome.Unresolved) revert NotResolved();

        uint256 gross;
        uint256 feeTotal;
        bool isVoid = outcome == Outcome.Void;

        for (uint256 i; i < tickList.length; ++i) {
            uint8 tk = tickList[i];
            if (tk >= NUM_TICKS) revert BadTick();

            uint128 y = yesPos[tk][msg.sender];
            uint128 n = noPos[tk][msg.sender];
            if (y == 0 && n == 0) continue;

            uint256 g;
            if (isVoid) {
                // refund each leg at what it paid; rounds DOWN, dust stays behind
                g = uint256(y).mulDivDown(legPrice(tk, true), ONE) + uint256(n).mulDivDown(legPrice(tk, false), ONE);
            } else if (outcome == Outcome.Yes) {
                g = y; // 1.00 per share
            } else {
                g = n;
            }

            if (y != 0) yesPos[tk][msg.sender] = 0;
            if (n != 0) noPos[tk][msg.sender] = 0;
            if (g == 0) continue;

            gross += g;

            if (!isVoid && feeBps > 0) {
                uint256 f = g.mulDivDown(feeBps, ONE);
                if (f > 0) {
                    Tick storage t = _ticks[tk];
                    uint256 crankCut = f.mulDivDown(crankShareBps, ONE);
                    if (crankCut > 0 && t.cranker != address(0)) {
                        t.crankAcc += uint128(crankCut);
                        t.feeAcc += uint128(f - crankCut);
                    } else {
                        t.feeAcc += uint128(f);
                    }
                    feeTotal += f;
                }
            }
        }

        net = gross - feeTotal;
        balance[msg.sender] += net;
        emit Claimed(msg.sender, net, feeTotal);
    }

    function claimAll() external returns (uint256) {
        uint8[] memory all_ = new uint8[](NUM_TICKS);
        for (uint8 i; i < NUM_TICKS; ++i) {
            all_[i] = i;
        }
        return claim(all_);
    }

    /// @notice Claim winnings and pull them out to the wallet in one transaction.
    function claimAndWithdraw() external returns (uint256 amount) {
        uint8[] memory all_ = new uint8[](NUM_TICKS);
        for (uint8 i; i < NUM_TICKS; ++i) {
            all_[i] = i;
        }
        claim(all_);
        amount = balance[msg.sender];
        if (amount > 0) {
            balance[msg.sender] = 0;
            (bool ok,) = msg.sender.call{value: amount}("");
            if (!ok) revert TransferFailed();
            emit Withdrawn(msg.sender, amount);
        }
    }

    /// @notice Send the protocol's accrued fees for the given ticks to feeRecipient.
    function sweepFees(uint8[] calldata tickList) external returns (uint256 amt) {
        for (uint256 i; i < tickList.length; ++i) {
            uint8 tk = tickList[i];
            if (tk >= NUM_TICKS) revert BadTick();
            amt += _ticks[tk].feeAcc;
            _ticks[tk].feeAcc = 0;
        }
        if (amt == 0) return 0;
        (bool ok,) = feeRecipient.call{value: amt}("");
        if (!ok) revert TransferFailed();
        emit FeesSwept(feeRecipient, amt);
    }

    /// @notice Pay the accrued crank reward for a tick to whoever last matched it.
    ///         Permissionless: removes the operator as a single point of failure.
    function payCrankReward(uint8 tick) external returns (uint256 amt) {
        if (tick >= NUM_TICKS) revert BadTick();
        Tick storage t = _ticks[tick];
        amt = t.crankAcc;
        address to = t.cranker;
        if (amt == 0 || to == address(0)) return 0;
        t.crankAcc = 0;
        balance[to] += amt; // credit, not push — no reentrancy surface
        emit CrankRewardPaid(tick, to, amt);
    }

    // ------------------------------------------------ views for the frontend

    function ticks(uint8 tick) external view returns (Tick memory) {
        return _ticks[tick];
    }

    function book() public view returns (Tick[] memory out) {
        out = new Tick[](NUM_TICKS);
        for (uint8 i; i < NUM_TICKS; ++i) {
            out[i] = _ticks[i];
        }
    }

    /// @notice Volume-weighted implied probability in bps. 5000 when the book is empty.
    function impliedBps() public view returns (uint256) {
        uint256 num;
        uint256 den;
        for (uint8 i; i < NUM_TICKS; ++i) {
            Tick storage t = _ticks[i];
            uint256 w = uint256(t.matched) * 2 + t.openYes + t.openNo;
            num += w * price(i);
            den += w;
        }
        return den == 0 ? ONE / 2 : num / den;
    }

    function positionsOf(address who) public view returns (uint128[] memory yes_, uint128[] memory no_) {
        yes_ = new uint128[](NUM_TICKS);
        no_ = new uint128[](NUM_TICKS);
        for (uint8 i; i < NUM_TICKS; ++i) {
            yes_[i] = yesPos[i][who];
            no_[i] = noPos[i][who];
        }
    }

    function orderCounts(uint8 tick) external view returns (uint256, uint256) {
        return (yesOrders[tick].length, noOrders[tick].length);
    }

    /// @notice Open (cancellable) order indices for `who` at one tick.
    ///         Powers "cancel before lock" in the UI without an indexer round-trip.
    function openOrdersOf(uint8 tick, bool isYes, address who)
        external
        view
        returns (uint32[] memory indices, uint128[] memory remaining)
    {
        Order[] storage arr = isYes ? yesOrders[tick] : noOrders[tick];
        uint256 len = arr.length;
        uint256 hits;
        for (uint256 i; i < len; ++i) {
            if (arr[i].maker == who && !arr[i].withdrawn && arr[i].filled < arr[i].shares) ++hits;
        }
        indices = new uint32[](hits);
        remaining = new uint128[](hits);
        uint256 k;
        for (uint256 i; i < len; ++i) {
            Order storage o = arr[i];
            if (o.maker == who && !o.withdrawn && o.filled < o.shares) {
                indices[k] = uint32(i);
                remaining[k] = o.shares - o.filled;
                ++k;
            }
        }
    }

    /// @notice Everything the app needs for one market in a single RPC call.
    ///         Keeps watch-mode cheap: one eth_call per market instead of twenty.
    function snapshot(address who)
        external
        view
        returns (
            string memory q,
            Phase ph,
            Outcome oc,
            uint64 openUntil_,
            uint64 resolveAfter_,
            uint256 implied,
            uint256 userBalance,
            Tick[] memory levels,
            uint128[] memory yesPositions,
            uint128[] memory noPositions
        )
    {
        q = question;
        ph = phase();
        oc = outcome;
        openUntil_ = openUntil;
        resolveAfter_ = resolveAfter;
        implied = impliedBps();
        userBalance = balance[who];
        levels = book();
        (yesPositions, noPositions) = positionsOf(who);
    }

    receive() external payable {
        deposit();
    }
}
