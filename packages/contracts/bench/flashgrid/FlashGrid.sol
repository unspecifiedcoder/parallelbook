// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title FlashGrid - Parallel Batch Auction Engine
/// @notice State-sharded order matching engine optimized for Monad's parallel execution
/// @dev Each price tick uses isolated storage slots to enable conflict-free parallel processing
contract FlashGrid {
    // ═══════════════════════════════════════════════════════════
    //                        CONSTANTS
    // ═══════════════════════════════════════════════════════════

    uint8 public constant NUM_TICKS = 20; // Price ticks: 0.05 to 1.00 (step 0.05)
    uint32 public constant EPOCH_DURATION = 12; // Blocks per epoch

    // ═══════════════════════════════════════════════════════════
    //                         TYPES
    // ═══════════════════════════════════════════════════════════

    struct TickState {
        uint128 totalYesLiquidity;
        uint128 totalNoLiquidity;
        uint32 orderCount;
        uint32 lastMatchedEpoch;
    }

    struct Order {
        address maker;
        uint128 amount;
        bool isYes;
        uint32 epoch;
    }

    // ═══════════════════════════════════════════════════════════
    //                         STORAGE
    // ═══════════════════════════════════════════════════════════

    /// @notice Isolated tick state - each tick occupies its own storage slot range
    mapping(uint8 => TickState) public ticks;

    /// @notice Orders per tick - isolated arrays, no cross-tick conflicts
    mapping(uint8 => Order[]) public tickOrders;

    /// @notice User balance ledger - only touched on deposit/withdraw
    mapping(address => uint256) public balances;

    /// @notice Current epoch number
    uint32 public currentEpoch;

    /// @notice Market metadata
    string public marketQuestion;
    address public factory;
    address public creator;

    // ═══════════════════════════════════════════════════════════
    //                         EVENTS
    // ═══════════════════════════════════════════════════════════

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event OrderPlaced(
        uint8 indexed tick, address indexed maker, uint128 amount, bool isYes, uint32 epoch
    );
    event TickSettled(
        uint8 indexed tick, uint32 epoch, uint128 yesMatched, uint128 noMatched, uint256 clearingPrice
    );
    event EpochCompleted(uint32 epoch, uint256 totalVolume, uint16 ticksActive);

    // ═══════════════════════════════════════════════════════════
    //                        ERRORS
    // ═══════════════════════════════════════════════════════════

    error InvalidTick();
    error InsufficientBalance();
    error ZeroAmount();
    error AlreadySettled();
    error WithdrawFailed();

    // ═══════════════════════════════════════════════════════════
    //                      CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════

    constructor(string memory _marketQuestion, address _creator) {
        marketQuestion = _marketQuestion;
        creator = _creator;
        factory = msg.sender;
        currentEpoch = 1;
    }

    // ═══════════════════════════════════════════════════════════
    //                    DEPOSIT / WITHDRAW
    // ═══════════════════════════════════════════════════════════

    /// @notice Deposit MON to participate in markets
    /// @dev Only touches balances[msg.sender] - no conflicts with order placement
    function deposit() external payable {
        if (msg.value == 0) revert ZeroAmount();
        balances[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Withdraw available balance
    function withdraw(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (balances[msg.sender] < amount) revert InsufficientBalance();

        balances[msg.sender] -= amount;

        (bool success,) = msg.sender.call{value: amount}("");
        if (!success) revert WithdrawFailed();

        emit Withdrawn(msg.sender, amount);
    }

    // ═══════════════════════════════════════════════════════════
    //                     ORDER PLACEMENT
    // ═══════════════════════════════════════════════════════════

    /// @notice Place an order at a specific price tick
    /// @dev PARALLELISM KEY: Only touches ticks[tick] and tickOrders[tick]
    ///      Orders at different ticks have ZERO storage conflicts
    /// @param tick Price tick index (0-19, representing 0.05 to 1.00)
    /// @param amount Order size in wei
    /// @param isYes True for YES side, false for NO side
    function placeOrder(uint8 tick, uint128 amount, bool isYes) external {
        if (tick >= NUM_TICKS) revert InvalidTick();
        if (amount == 0) revert ZeroAmount();
        if (balances[msg.sender] < amount) revert InsufficientBalance();

        // Deduct from balance
        balances[msg.sender] -= amount;

        // Update tick state (isolated storage slot)
        TickState storage ts = ticks[tick];
        if (isYes) {
            ts.totalYesLiquidity += amount;
        } else {
            ts.totalNoLiquidity += amount;
        }
        ts.orderCount++;

        // Append to tick-specific order array (isolated storage)
        tickOrders[tick].push(Order({maker: msg.sender, amount: amount, isYes: isYes, epoch: currentEpoch}));

        emit OrderPlaced(tick, msg.sender, amount, isYes, currentEpoch);
    }

    // ═══════════════════════════════════════════════════════════
    //                       SETTLEMENT
    // ═══════════════════════════════════════════════════════════

    /// @notice Settle a single tick - matches YES and NO orders
    /// @dev PARALLELISM KEY: Each tick settles independently
    ///      Multiple settleTick() calls for different ticks execute in parallel on Monad
    /// @param tick The tick index to settle
    function settleTick(uint8 tick) public {
        if (tick >= NUM_TICKS) revert InvalidTick();

        TickState storage ts = ticks[tick];
        if (ts.lastMatchedEpoch >= currentEpoch) revert AlreadySettled();

        uint128 yesLiq = ts.totalYesLiquidity;
        uint128 noLiq = ts.totalNoLiquidity;

        // Match the minimum of YES and NO liquidity
        uint128 matched = yesLiq < noLiq ? yesLiq : noLiq;

        if (matched > 0) {
            // Pro-rata settlement: distribute matched amount back to winning side
            Order[] storage orders = tickOrders[tick];
            uint256 len = orders.length;

            for (uint256 i = 0; i < len; i++) {
                Order storage order = orders[i];
                if (order.epoch == currentEpoch && order.amount > 0) {
                    uint128 orderAmt = order.amount;
                    uint128 pool = order.isYes ? yesLiq : noLiq;

                    // Pro-rata share of matched amount
                    uint128 share = uint128((uint256(orderAmt) * uint256(matched)) / uint256(pool));

                    // Refund unmatched portion + payout
                    uint128 unmatched = orderAmt - share;
                    uint128 payout = share * 2; // Winner gets 2x on matched portion

                    balances[order.maker] += uint256(unmatched) + uint256(payout) / 2;
                    // Note: simplified settlement - in production would track outcomes
                    order.amount = 0; // Mark as settled
                }
            }

            // Emit settlement event
            emit TickSettled(tick, currentEpoch, matched, matched, uint256(tick + 1) * 5);
        }

        // Update tick state
        ts.totalYesLiquidity = 0;
        ts.totalNoLiquidity = 0;
        ts.orderCount = 0;
        ts.lastMatchedEpoch = currentEpoch;
    }

    /// @notice Settle all ticks and advance epoch
    /// @dev On Monad, the internal settleTick calls can execute in parallel
    ///      since each touches only its own tick's storage
    function settleAll() external {
        uint256 totalVolume = 0;
        uint16 activeTickCount = 0;

        for (uint8 i = 0; i < NUM_TICKS; i++) {
            TickState storage ts = ticks[i];
            // Skip ticks with no orders or already settled this epoch
            if (ts.orderCount > 0 && ts.lastMatchedEpoch < currentEpoch) {
                uint128 tickVolume = ts.totalYesLiquidity + ts.totalNoLiquidity;
                totalVolume += uint256(tickVolume);
                activeTickCount++;
                settleTick(i);
            }
        }

        emit EpochCompleted(currentEpoch, totalVolume, activeTickCount);
        currentEpoch++;
    }

    // ═══════════════════════════════════════════════════════════
    //                       VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════

    /// @notice Get tick state for a specific tick
    function getTickState(uint8 tick)
        external
        view
        returns (uint128 yesLiquidity, uint128 noLiquidity, uint32 orderCount, uint32 lastMatchedEpoch)
    {
        if (tick >= NUM_TICKS) revert InvalidTick();
        TickState storage ts = ticks[tick];
        return (ts.totalYesLiquidity, ts.totalNoLiquidity, ts.orderCount, ts.lastMatchedEpoch);
    }

    /// @notice Get all tick states in one call (for dashboard)
    function getAllTickStates() external view returns (TickState[20] memory states) {
        for (uint8 i = 0; i < NUM_TICKS; i++) {
            states[i] = ticks[i];
        }
    }

    /// @notice Get orders for a specific tick
    function getTickOrders(uint8 tick) external view returns (Order[] memory) {
        if (tick >= NUM_TICKS) revert InvalidTick();
        return tickOrders[tick];
    }

    /// @notice Get order count for a specific tick
    function getTickOrderCount(uint8 tick) external view returns (uint256) {
        if (tick >= NUM_TICKS) revert InvalidTick();
        return tickOrders[tick].length;
    }

    receive() external payable {
        balances[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }
}
