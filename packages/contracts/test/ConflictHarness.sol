// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";

/**
 * Shared machinery for measuring a workload's conflict graph.
 *
 * vm.record()/vm.accesses() give the exact storage slots a call read and wrote, so
 * the conflict graph of a transaction set is directly observable -- no chain, no
 * money, no RPC. Greedily colouring that graph yields the number of sequential
 * ROUNDS an optimistic scheduler needs; width = txs / rounds is the ceiling on
 * concurrency any parallel EVM could extract from the workload.
 *
 * This measures the MECHANISM, not the effect. Width is an upper bound that only
 * turns into wall-clock speedup once execution -- rather than block time or
 * consensus -- is the binding constraint.
 */
abstract contract ConflictHarness is Test {
    mapping(uint256 => bytes32[]) private wr;
    mapping(uint256 => bytes32[]) private rd;
    uint256 internal n;

    function _reset() internal {
        for (uint256 i; i < n; ++i) {
            delete wr[i];
            delete rd[i];
        }
        n = 0;
    }

    function _capture(address target) internal {
        (bytes32[] memory reads, bytes32[] memory writes) = vm.accesses(target);
        for (uint256 i; i < writes.length; ++i) wr[n].push(writes[i]);
        for (uint256 i; i < reads.length; ++i) rd[n].push(reads[i]);
        ++n;
    }

    function _intersects(bytes32[] storage a, bytes32[] storage b) internal view returns (bool) {
        for (uint256 i; i < a.length; ++i) {
            for (uint256 j; j < b.length; ++j) {
                if (a[i] == b[j]) return true;
            }
        }
        return false;
    }

    /// Two txs conflict if either one's writes touch the other's reads or writes.
    /// Shared READS are free -- that is the whole basis of optimistic concurrency.
    function _conflicts(uint256 i, uint256 j) internal view returns (bool) {
        return _intersects(wr[i], wr[j]) || _intersects(wr[i], rd[j]) || _intersects(wr[j], rd[i]);
    }

    /// Greedy graph colouring. Each colour is one round of concurrent execution.
    function _rounds() internal view returns (uint256) {
        uint256[] memory colour = new uint256[](n);
        uint256 used;
        for (uint256 i; i < n; ++i) {
            bool[] memory blocked = new bool[](n + 1);
            for (uint256 j; j < i; ++j) {
                if (_conflicts(i, j)) blocked[colour[j]] = true;
            }
            uint256 c;
            while (c < n && blocked[c]) ++c;
            colour[i] = c;
            if (c + 1 > used) used = c + 1;
        }
        return used;
    }

    function _report(string memory label, uint256 txs, uint256 rounds) internal pure {
        // width in hundredths, because Solidity has no decimals
        uint256 width = rounds == 0 ? 0 : (txs * 100) / rounds;
        console2.log(label, txs, rounds, width);
    }
}
