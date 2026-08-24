// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {console2} from "forge-std/console2.sol";
import {ConflictHarness} from "./ConflictHarness.sol";
import {Market} from "../src/Market.sol";
import {NaiveBook} from "../bench/NaiveBook.sol";

/**
 * Does state sharding actually buy parallelism?
 *
 * A parallel EVM (Monad, Block-STM, Sei) schedules optimistically: it runs
 * transactions concurrently and re-executes any whose read set was invalidated by
 * another transaction's write. So the ONLY thing that decides whether parallelism
 * helps is the conflict graph of the workload -- two transactions conflict when one
 * writes a slot the other reads or writes.
 *
 * That graph is exactly measurable here, with no chain and no money, because
 * vm.record() reports the precise slots every call touched. Greedily colouring the
 * graph gives the number of sequential ROUNDS the workload needs; width = txs /
 * rounds is the maximum concurrency any optimistic scheduler could extract.
 *
 * This measures the mechanism, not the effect. Wall-clock latency on a real parallel
 * chain is downstream of this number and confounded by mempool, RPC and block
 * packing -- which is why every attempt to measure it over a public endpoint failed.
 * If the width here is 1, no chain can save you. If it is 19, the ceiling is 19.
 */
contract ConflictTest is ConflictHarness {
    uint8 constant TICKS = 19;
    uint128 constant SH = 1e18;

    Market market;
    NaiveBook naive;

    function setUp() public {
        market = new Market("conflict probe", address(this), address(this), 100, 1_000, 3_000, 6_000);
        naive = new NaiveBook();
    }

    // ---------------------------------------------------------------- experiments

    /// Seed both books, then measure the conflict graph of the MATCHING phase.
    function test_matching_conflict_graph() public {
        console2.log("label | txs | rounds | width(x100)");

        // Market: one matchTick per distinct tick.
        market.deposit{value: 400 ether}();
        for (uint8 t; t < TICKS; ++t) {
            market.place(t, SH, true);
            market.place(t, SH, false);
        }
        _reset();
        for (uint8 t; t < TICKS; ++t) {
            vm.record();
            market.matchTick(t, 8);
            _capture(address(market));
        }
        uint256 sharded = _rounds();
        _report("market.matchTick  ", n, sharded);

        assertEq(sharded, 1, "19 ticks must colour into a single concurrent round");
    }

    /// The baseline: same logical work, shared slots.
    function test_naive_conflict_graph() public {
        naive.deposit{value: 400 ether}();
        _reset();
        for (uint8 t; t < TICKS; ++t) {
            vm.record();
            naive.place(t, SH, true);
            _capture(address(naive));
        }
        uint256 rounds = _rounds();
        _report("naive.place       ", n, rounds);

        assertEq(rounds, n, "every naive write conflicts: rounds must equal txs");
    }

    /// Contention sweep, done properly: a FIXED workload of 19 match transactions
    /// spread over a shrinking number of distinct ticks. Holding the transaction
    /// count constant is the whole point -- varying both at once measures nothing,
    /// because one transaction per tick can never contend with anything.
    function test_contention_curve() public {
        console2.log("distinctTicks | txs | rounds | width(x100)");
        uint8[5] memory spread = [uint8(19), 10, 5, 2, 1];

        for (uint256 s; s < spread.length; ++s) {
            uint8 t_count = spread[s];
            Market m = new Market("sweep", address(this), address(this), 100, 1_000, 3_000, 6_000);
            m.deposit{value: 800 ether}();
            // Seed every tick we are about to touch, several deep, so repeated
            // matchTick calls on one tick have something to do.
            for (uint8 t; t < t_count; ++t) {
                for (uint256 k; k < 4; ++k) {
                    m.place(t, SH, true);
                    m.place(t, SH, false);
                }
            }
            _reset();
            // 19 transactions either way; only the spread changes.
            for (uint256 i; i < TICKS; ++i) {
                uint8 t = uint8(i % t_count);
                vm.record();
                m.matchTick(t, 2);
                _capture(address(m));
            }
            uint256 r = _rounds();
            console2.log("spread", t_count, n, r);
            console2.log("   width(x100)", (n * 100) / r);
        }
    }

    /// Does a single funded sender defeat the sharding? This is the question that
    /// decides whether the benchmark harness itself is valid.
    function test_single_sender_place_conflicts() public {
        console2.log("-- place() from ONE sender --");
        market.deposit{value: 400 ether}();
        _reset();
        for (uint8 t; t < TICKS; ++t) {
            vm.record();
            market.place(t, SH, true);
            _capture(address(market));
        }
        uint256 rounds = _rounds();
        _report("place 1 sender    ", n, rounds);
    }

    /// The same places, one distinct sender each.
    function test_many_sender_place_conflicts() public {
        console2.log("-- place() from 19 senders --");
        _reset();
        for (uint8 t; t < TICKS; ++t) {
            address who = address(uint160(0xA000 + t));
            vm.deal(who, 10 ether);
            vm.startPrank(who);
            market.deposit{value: 5 ether}();
            vm.record();
            market.place(t, SH, true);
            _capture(address(market));
            vm.stopPrank();
        }
        uint256 rounds = _rounds();
        _report("place 19 senders  ", n, rounds);
    }

    receive() external payable {}
}
