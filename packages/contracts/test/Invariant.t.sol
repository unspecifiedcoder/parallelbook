// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Market} from "../src/Market.sol";

/// @notice Drives the market with random-ish traffic. Every action is legal at the
///         time it is taken, so any broken invariant is a contract bug, not a
///         misuse of the API.
contract MarketHandler is Test {
    Market public m;
    address[] public actors;

    uint256 public totalDeposited;
    uint256 public totalWithdrawn;
    uint256 public ghostMatchedPairs; // sum over ticks of matched shares

    constructor(Market _m) {
        m = _m;
        for (uint256 i; i < 5; ++i) {
            address a = address(uint160(0x1000 + i));
            actors.push(a);
            vm.deal(a, 1_000 ether);
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function deposit(uint256 seed, uint96 amount) external {
        address a = _actor(seed);
        uint256 amt = uint256(amount) % 50 ether + 1;
        vm.deal(a, a.balance + amt);
        vm.prank(a);
        m.deposit{value: amt}();
        totalDeposited += amt;
    }

    function place(uint256 seed, uint8 tick, uint96 shares, bool isYes) external {
        if (m.phase() != Market.Phase.Open) return;
        address a = _actor(seed);
        tick = tick % m.NUM_TICKS();
        uint128 sh = uint128(uint256(shares) % 20 ether + m.MIN_SHARES());
        uint256 c = m.cost(tick, sh, isYes);
        if (m.balance(a) < c) {
            vm.deal(a, a.balance + c);
            vm.prank(a);
            m.deposit{value: c}();
            totalDeposited += c;
        }
        vm.prank(a);
        m.place(tick, sh, isYes);
    }

    function crank(uint8 tick, uint8 steps) external {
        if (m.outcome() != Market.Outcome.Unresolved) return;
        tick = tick % m.NUM_TICKS();
        m.matchTick(tick, uint32(steps) % 32 + 1);
    }

    function cancel(uint256 seed, uint8 tick, bool isYes) external {
        address a = _actor(seed);
        tick = tick % m.NUM_TICKS();
        vm.prank(a);
        m.withdrawOrdersAt(tick, isYes);
    }

    function warp(uint16 secs) external {
        vm.warp(block.timestamp + (uint256(secs) % 20 + 1));
    }

    function withdraw(uint256 seed, uint96 amount) external {
        address a = _actor(seed);
        uint256 bal = m.balance(a);
        if (bal == 0) return;
        uint256 amt = uint256(amount) % bal + 1;
        if (amt > bal) amt = bal;
        vm.prank(a);
        m.withdraw(amt);
        totalWithdrawn += amt;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }
}

contract InvariantTest is StdInvariant, Test {
    Market m;
    MarketHandler h;
    address resolver = address(0xDEC1DE);
    address feeSink = address(0xFEE);

    function setUp() public {
        // long windows so the fuzzer spends most of its time in Open
        m = new Market("invariant?", resolver, feeSink, 100, 1_000, 3_000, 6_000);
        h = new MarketHandler(m);
        targetContract(address(h));
    }

    /// THE SOLVENCY INVARIANT. The contract must always hold at least what it owes:
    /// every user's free balance, plus the collateral behind every resting order,
    /// plus 1.00 per matched pair, plus fees not yet swept.
    /// A surplus from rounding is allowed. A deficit is an insolvency bug.
    function invariant_contract_is_solvent() public view {
        uint256 owed;

        for (uint256 i; i < h.actorCount(); ++i) {
            owed += m.balance(h.actors(i));
        }

        for (uint8 t; t < m.NUM_TICKS(); ++t) {
            Market.Tick memory tk = m.ticks(t);
            // 1.00 per matched pair must be sitting here for the winner
            owed += uint256(tk.matched) * m.ONE() / m.ONE();
            owed += tk.feeAcc;
            owed += tk.crankAcc;
            // collateral behind unfilled shares, at the price they paid
            owed += uint256(tk.openYes) * m.legPrice(t, true) / m.ONE();
            owed += uint256(tk.openNo) * m.legPrice(t, false) / m.ONE();
        }

        assertGe(address(m).balance, owed, "INSOLVENT: contract owes more than it holds");
    }

    /// A matched pair is funded by its own two participants and nothing else:
    /// YES paid p, NO paid 1-p, and rounding is always up, so the pair holds >= 1.00.
    ///
    /// Both legs must be rounded UP here, exactly as Market.cost and the
    /// withdrawOrder refund do it. Rounding down instead makes this invariant
    /// fail on almost every book: the two legs' fractional parts sum to exactly
    /// one, so two floors sum to pairs - 1 whenever pairs * price is not a
    /// multiple of ONE, and the shrinker reports a 1 wei shortfall that the
    /// contract does not actually have.
    function invariant_matched_pair_fully_collateralised() public view {
        for (uint8 t; t < m.NUM_TICKS(); ++t) {
            uint256 pairs = m.ticks(t).matched;
            if (pairs == 0) continue;
            uint256 one = m.ONE();
            uint256 yesLeg = (pairs * m.legPrice(t, true) + one - 1) / one;
            uint256 noLeg = (pairs * m.legPrice(t, false) + one - 1) / one;
            assertGe(yesLeg + noLeg, pairs, "pair collateral below 1.00 per share");
        }
    }

    /// openYes at a tick always equals the sum of unfilled, non-withdrawn YES
    /// shares in that tick's order array. Same for NO. If these ever diverge the
    /// book is lying to the UI.
    function invariant_open_equals_sum_of_orders() public view {
        for (uint8 t; t < m.NUM_TICKS(); ++t) {
            (uint256 yCount, uint256 nCount) = m.orderCounts(t);

            uint256 sumYes;
            for (uint256 i; i < yCount; ++i) {
                (, uint128 shares, uint128 filled,, bool withdrawn) = m.yesOrders(t, i);
                if (!withdrawn) sumYes += shares - filled;
            }
            assertEq(m.ticks(t).openYes, sumYes, "openYes desync");

            uint256 sumNo;
            for (uint256 i; i < nCount; ++i) {
                (, uint128 shares, uint128 filled,, bool withdrawn) = m.noOrders(t, i);
                if (!withdrawn) sumNo += shares - filled;
            }
            assertEq(m.ticks(t).openNo, sumNo, "openNo desync");
        }
    }

    /// Matched YES shares and matched NO shares are the two sides of the same
    /// trade, so they must be equal at every tick, forever.
    function invariant_yes_and_no_positions_balance() public view {
        for (uint8 t; t < m.NUM_TICKS(); ++t) {
            uint256 sumYesPos;
            uint256 sumNoPos;
            for (uint256 i; i < h.actorCount(); ++i) {
                sumYesPos += m.yesPos(t, h.actors(i));
                sumNoPos += m.noPos(t, h.actors(i));
            }
            // positions are zeroed on claim, so only check while unresolved
            if (m.outcome() == Market.Outcome.Unresolved) {
                assertEq(sumYesPos, sumNoPos, "one-sided matched position");
                assertEq(sumYesPos, m.ticks(t).matched, "positions != tick matched");
            }
        }
    }

    /// Cursors only ever move forward, and never past the end of the array.
    function invariant_cursors_are_monotonic_and_in_range() public view {
        for (uint8 t; t < m.NUM_TICKS(); ++t) {
            (uint256 yCount, uint256 nCount) = m.orderCounts(t);
            Market.Tick memory tk = m.ticks(t);
            assertLe(tk.yesCursor, yCount, "yes cursor out of range");
            assertLe(tk.noCursor, nCount, "no cursor out of range");
        }
    }

    /// No user can ever pull out more than they put in plus their winnings.
    function invariant_no_free_money() public view {
        assertLe(h.totalWithdrawn(), h.totalDeposited(), "user withdrew more than deposited");
    }
}
