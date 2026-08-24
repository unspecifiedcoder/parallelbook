// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ParallelBenchmark - Sequential Baseline
/// @notice Intentionally creates storage conflicts to demonstrate sequential execution
/// @dev All operations touch the SAME storage slot, forcing Monad to re-execute
///      transactions serially. Used as the "before" in the before/after comparison.
contract ParallelBenchmark {
    // Single shared counter - ALL transactions conflict on this slot
    uint256 public globalCounter;

    // Single shared array - ALL inserts conflict on array.length
    uint256[] public allOrders;

    // Events for measurement parity with FlashGrid
    event OrderPlaced(uint256 indexed orderId, address indexed maker, uint256 amount);

    /// @notice Place an order (sequential bottleneck version)
    /// @dev Every call increments globalCounter AND pushes to allOrders
    ///      Both operations touch shared state → forces serial execution on Monad
    function placeOrder(uint256 amount) external {
        globalCounter++;
        allOrders.push(amount);
        emit OrderPlaced(globalCounter, msg.sender, amount);
    }

    /// @notice Get total number of orders
    function getOrderCount() external view returns (uint256) {
        return allOrders.length;
    }
}
