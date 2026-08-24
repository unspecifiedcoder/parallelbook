// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {console2} from "forge-std/console2.sol";
import {ConflictHarness} from "./ConflictHarness.sol";
import {Market} from "../src/Market.sol";
import {NaiveBook} from "../bench/NaiveBook.sol";
import {FlashGrid} from "../bench/flashgrid/FlashGrid.sol";
import {ParallelBenchmark} from "../bench/flashgrid/ParallelBenchmark.sol";

/**
 * Cross-benchmark: is our sequential baseline honest, and is FlashGrid's?
 *
 * A parallel-vs-sequential benchmark is only meaningful if both arms do the SAME
 * WORK. If the "sequential" contract is cheaper, any latency gap it shows is partly
 * -- or entirely -- a gap in workload, not in scheduling.
 *
 * NaiveBook was written to be work-matched against Market.place: same price maths,
 * same rounding, same balance debit, same struct push, same event. FlashGrid's
 * ParallelBenchmark was not: it does a counter increment and a uint256 push, with
 * no balance ledger and no pricing at all, while the FlashGrid side it is compared
 * against does bounds checks, a balance debit, tick-state maths and a struct push.
 *
 * Gas is the arbiter. Both facts below are measured, not asserted.
 */
contract CrossBenchTest is ConflictHarness {
    uint8 constant TICKS = 19;
    uint128 constant SH = 1e18;

    Market market;
    NaiveBook naive;
    FlashGrid grid;
    ParallelBenchmark pbench;

    function setUp() public {
        market = new Market("cross bench", address(this), address(this), 100, 1_000, 3_000, 6_000);
        naive = new NaiveBook();
        grid = new FlashGrid("cross bench", address(this));
        pbench = new ParallelBenchmark();

        market.deposit{value: 400 ether}();
        naive.deposit{value: 400 ether}();
        grid.deposit{value: 400 ether}();
    }

    // ------------------------------------------------------------------- gas

    /// Average gas per order placement, warm (second pass over already-touched
    /// slots) so the numbers reflect steady state rather than one-off slot
    /// initialisation. The comparison that matters is WITHIN each project:
    /// Market vs NaiveBook, and FlashGrid vs ParallelBenchmark.
    function test_gas_per_order() public {
        // pass 1 warms every slot each contract will touch
        for (uint8 t; t < TICKS; ++t) {
            market.place(t, SH, true);
            naive.place(t, SH, true);
            grid.placeOrder(t, SH, true);
            pbench.placeOrder(uint256(SH));
        }

        uint256 gMarket = _timeMarket();
        uint256 gNaive = _timeNaive();
        uint256 gGrid = _timeGrid();
        uint256 gPBench = _timePBench();

        console2.log("gas/order  parallel-side | sequential-side | delta%");
        console2.log("ours      ", gMarket, gNaive, _pct(gNaive, gMarket));
        console2.log("flashgrid ", gGrid, gPBench, _pct(gPBench, gGrid));

        // Our baseline must not be a strawman: it has to cost at least as much as
        // the contract it is the baseline FOR. If NaiveBook were cheaper, every
        // latency win we claimed would be partly a workload artefact.
        assertGe(gNaive, (gMarket * 90) / 100, "NaiveBook must be work-matched to Market.place");

        // FlashGrid's baseline is not. Recorded as a measurement, not an insult:
        // it is why we did not adopt it.
        assertLt(gPBench, gGrid, "ParallelBenchmark does strictly less work than FlashGrid");
    }

    function _timeMarket() internal returns (uint256 g) {
        g = gasleft();
        for (uint8 t; t < TICKS; ++t) market.place(t, SH, true);
        g = (g - gasleft()) / TICKS;
    }

    function _timeNaive() internal returns (uint256 g) {
        g = gasleft();
        for (uint8 t; t < TICKS; ++t) naive.place(t, SH, true);
        g = (g - gasleft()) / TICKS;
    }

    function _timeGrid() internal returns (uint256 g) {
        g = gasleft();
        for (uint8 t; t < TICKS; ++t) grid.placeOrder(t, SH, true);
        g = (g - gasleft()) / TICKS;
    }

    function _timePBench() internal returns (uint256 g) {
        g = gasleft();
        for (uint8 t; t < TICKS; ++t) pbench.placeOrder(uint256(SH));
        g = (g - gasleft()) / TICKS;
    }

    /// b as a percentage of a, so 100 means identical work.
    function _pct(uint256 a, uint256 b) internal pure returns (uint256) {
        return b == 0 ? 0 : (a * 100) / b;
    }

    // ----------------------------------------------------------------- width

    /// FlashGrid's own claim, measured with the same instrument we point at ours.
    ///
    /// Run twice, because the answer depends on something their README does not
    /// mention: settleTick credits balances[order.maker], which is keyed by MAKER
    /// ONLY. Two ticks settle in parallel only if no trader appears in both. Our
    /// matchTick credits yesPos[tick][maker] -- keyed by tick AND maker -- so it
    /// stays disjoint even when the same trader is present at every tick.
    function test_flashgrid_settle_conflict_graph() public {
        console2.log("label | txs | rounds | width(x100)");

        // (a) shared maker: one trader quoting across the book.
        for (uint8 t; t < TICKS; ++t) {
            grid.placeOrder(t, SH, true);
            grid.placeOrder(t, SH, false);
        }
        _reset();
        for (uint8 t; t < TICKS; ++t) {
            vm.record();
            grid.settleTick(t);
            _capture(address(grid));
        }
        uint256 sharedMaker = _rounds();
        _report("fg.settle shared maker", n, sharedMaker);

        // (b) disjoint makers: a fresh pair of traders per tick.
        FlashGrid g2 = new FlashGrid("disjoint", address(this));
        for (uint8 t; t < TICKS; ++t) {
            _fund(g2, address(uint160(0xB000 + t)), t, true);
            _fund(g2, address(uint160(0xC000 + t)), t, false);
        }
        _reset();
        for (uint8 t; t < TICKS; ++t) {
            vm.record();
            g2.settleTick(t);
            _capture(address(g2));
        }
        uint256 disjointMaker = _rounds();
        _report("fg.settle disjoint    ", n, disjointMaker);

        // The baseline they compare against: fully serial, as designed.
        _reset();
        for (uint8 t; t < TICKS; ++t) {
            vm.record();
            pbench.placeOrder(uint256(t));
            _capture(address(pbench));
        }
        uint256 pbRounds = _rounds();
        _report("fg.baseline           ", n, pbRounds);

        // Their sharding IS real -- but only under disjoint makers.
        assertEq(disjointMaker, 1, "disjoint makers: settleTick should colour into one round");
        assertEq(sharedMaker, n, "shared maker: the balances[] credit reserialises every tick");
        assertEq(pbRounds, n, "the shared-counter baseline must be fully serial");
    }

    /// The same shared-maker workload against OUR matcher, which stays disjoint
    /// because positions are keyed by tick as well as by maker.
    function test_our_settle_survives_a_shared_maker() public {
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
        uint256 rounds = _rounds();
        _report("market.matchTick shared maker", n, rounds);
        assertEq(rounds, 1, "tick-keyed positions must stay disjoint under one maker");
    }

    function _fund(FlashGrid g, address who, uint8 tick, bool isYes) internal {
        vm.deal(who, 10 ether);
        vm.startPrank(who);
        g.deposit{value: 5 ether}();
        g.placeOrder(tick, SH, isYes);
        vm.stopPrank();
    }

    /// The finding that actually matters, reproduced against FlashGrid: placing
    /// from ONE sender is serial no matter how well the ticks are sharded, because
    /// every call writes balances[msg.sender]. Both codebases have this property.
    function test_flashgrid_single_sender_place_is_serial() public {
        _reset();
        for (uint8 t; t < TICKS; ++t) {
            vm.record();
            grid.placeOrder(t, SH, true);
            _capture(address(grid));
        }
        uint256 rounds = _rounds();
        _report("flashgrid.place 1 sender", n, rounds);
        assertEq(rounds, n, "one sender's balance slot serialises every placement");
    }

    receive() external payable {}
}
