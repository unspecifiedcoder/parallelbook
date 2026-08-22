// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Market} from "../src/Market.sol";
import {MarketFactory} from "../src/MarketFactory.sol";
import {Series} from "../src/Series.sol";

contract MarketTest is Test {
    Market m;

    address resolver = address(0xDEC1DE);
    address feeSink = address(0xFEE);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA201);
    address cranker = address(0xC7A1);

    uint256 constant ONE = 10_000;
    uint8 constant TICK_65 = 12; // (12+1)*500 = 6500 = 0.65
    uint128 constant SH = 1e18; // one share

    function setUp() public {
        m = new Market("Will there be a boundary this over?", resolver, feeSink, 100, 1_000, 45, 60);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
        vm.deal(cranker, 1 ether);
    }

    // ------------------------------------------------------------- pricing

    function test_price_ladder() public view {
        assertEq(m.price(0), 500);
        assertEq(m.price(12), 6500);
        assertEq(m.price(18), 9500);
        assertEq(m.NUM_TICKS(), 19);
    }

    function test_legs_sum_to_one() public view {
        for (uint8 i; i < 19; ++i) {
            assertEq(m.legPrice(i, true) + m.legPrice(i, false), ONE);
        }
    }

    function test_price_reverts_out_of_range() public {
        vm.expectRevert(Market.BadTick.selector);
        m.price(19);
    }

    // ------------------------------------------------ the worked example

    // Alice buys 100 YES @ 0.65 (cost 65). Bob buys 60 NO @ 0.65 (cost 21).
    /// 60 shares match. Alice has 40 shares unfilled -> 26 reclaimable.
    function _workedExample() internal {
        vm.prank(alice);
        m.place{value: 65 ether}(TICK_65, 100 * SH, true);
        vm.prank(bob);
        m.place{value: 21 ether}(TICK_65, 60 * SH, false);
        // place() auto-matches, so the pair is already crossed here.
        vm.prank(cranker);
        m.matchTick(TICK_65, 50);
    }

    function test_worked_example_matches_60() public {
        _workedExample();
        Market.Tick memory t = m.ticks(TICK_65);
        assertEq(t.matched, 60 * SH, "60 pairs matched");
        assertEq(t.openYes, 40 * SH, "40 YES left resting");
        assertEq(t.openNo, 0, "NO fully filled");
        assertEq(m.yesPos(TICK_65, alice), 60 * SH);
        assertEq(m.noPos(TICK_65, bob), 60 * SH);
    }

    function test_worked_example_yes_wins() public {
        _workedExample();
        vm.warp(block.timestamp + 61);
        vm.prank(resolver);
        m.resolve(Market.Outcome.Yes);

        vm.prank(alice);
        uint256 net = m.claimAll();
        assertEq(net, 59.4 ether, "60.00 gross minus 1% fee");

        vm.prank(bob);
        assertEq(m.claimAll(), 0, "loser gets nothing");

        // Alice separately reclaims the 26.00 behind her unfilled 40 shares
        vm.prank(alice);
        uint256 refund = m.withdrawOrder(TICK_65, true, 0);
        assertEq(refund, 26 ether);
        assertEq(m.balance(alice), 59.4 ether + 26 ether);
    }

    function test_worked_example_no_wins() public {
        _workedExample();
        vm.warp(block.timestamp + 61);
        vm.prank(resolver);
        m.resolve(Market.Outcome.No);

        vm.prank(bob);
        assertEq(m.claimAll(), 59.4 ether);
        vm.prank(alice);
        assertEq(m.claimAll(), 0);

        vm.prank(alice);
        assertEq(m.withdrawOrder(TICK_65, true, 0), 26 ether, "alice keeps only her refund");
    }

    function test_worked_example_void() public {
        _workedExample();
        vm.warp(block.timestamp + 61);
        vm.prank(resolver);
        m.resolve(Market.Outcome.Void);

        vm.prank(alice);
        assertEq(m.claimAll(), 39 ether, "60 x 0.65");
        vm.prank(bob);
        assertEq(m.claimAll(), 21 ether, "60 x 0.35");

        // no fee on void
        uint8[] memory all_ = _allTicks();
        uint256 swept = m.sweepFees(all_);
        assertEq(swept, 0, "void charges no fee");
    }

    // --------------------------------------------------------- order flow

    function test_cost_rounds_up() public view {
        // 3 wei of shares at 0.05 -> 0.15 wei, must round to 1
        assertEq(m.cost(0, 3, true), 1);
        assertEq(m.cost(TICK_65, 1, true), 1);
    }

    function test_place_debits_exactly_cost() public {
        vm.prank(alice);
        m.place{value: 10 ether}(TICK_65, 10 * SH, true);
        assertEq(m.balance(alice), 10 ether - 6.5 ether);
    }

    function test_place_rejects_dust() public {
        vm.prank(alice);
        vm.expectRevert(Market.TooSmall.selector);
        m.place{value: 1 ether}(TICK_65, 1e14, true);
    }

    function test_place_rejects_after_open_window() public {
        vm.warp(block.timestamp + 46);
        vm.prank(alice);
        vm.expectRevert(Market.NotOpen.selector);
        m.place{value: 1 ether}(TICK_65, SH, true);
    }

    function test_place_rejects_when_paused_but_claims_still_work() public {
        _workedExample();
        vm.prank(resolver);
        m.setTradingPaused(true);

        vm.prank(carol);
        vm.expectRevert(Market.Paused.selector);
        m.place{value: 1 ether}(TICK_65, SH, true);

        // a pause must never trap funds
        vm.prank(alice);
        m.withdrawOrder(TICK_65, true, 0);
        vm.warp(block.timestamp + 61);
        vm.prank(resolver);
        m.resolve(Market.Outcome.Yes);
        vm.prank(alice);
        assertGt(m.claimAll(), 0, "claims work while paused");
    }

    function test_auto_match_inside_place() public {
        vm.prank(alice);
        m.place{value: 65 ether}(TICK_65, 100 * SH, true);
        vm.prank(bob);
        m.place{value: 21 ether}(TICK_65, 60 * SH, false);
        // no explicit crank: place() should already have crossed the book
        assertEq(m.ticks(TICK_65).matched, 60 * SH, "filled in the same tx");
    }

    function test_partial_fills_fifo() public {
        vm.prank(alice);
        m.place{value: 10 ether}(TICK_65, 10 * SH, true); // yes #0
        vm.prank(carol);
        m.place{value: 10 ether}(TICK_65, 10 * SH, true); // yes #1
        vm.prank(bob);
        m.place{value: 10 ether}(TICK_65, 15 * SH, false);

        // FIFO: alice fully filled first, then carol partially
        assertEq(m.yesPos(TICK_65, alice), 10 * SH);
        assertEq(m.yesPos(TICK_65, carol), 5 * SH);
        assertEq(m.noPos(TICK_65, bob), 15 * SH);
    }

    function test_cancel_while_open_returns_full_cost() public {
        vm.prank(alice);
        m.place{value: 65 ether}(TICK_65, 100 * SH, true);
        uint256 before = m.balance(alice);
        vm.prank(alice);
        uint256 refund = m.withdrawOrder(TICK_65, true, 0);
        assertEq(refund, 65 ether);
        assertEq(m.balance(alice), before + 65 ether);
        assertEq(m.ticks(TICK_65).openYes, 0);
    }

    function test_withdraw_order_only_by_maker_and_only_once() public {
        vm.prank(alice);
        m.place{value: 65 ether}(TICK_65, 100 * SH, true);

        vm.prank(bob);
        vm.expectRevert(Market.NotYours.selector);
        m.withdrawOrder(TICK_65, true, 0);

        vm.prank(alice);
        m.withdrawOrder(TICK_65, true, 0);
        vm.prank(alice);
        vm.expectRevert(Market.NotYours.selector);
        m.withdrawOrder(TICK_65, true, 0);
    }

    function test_withdrawn_order_is_skipped_by_matching() public {
        vm.prank(alice);
        m.place{value: 10 ether}(TICK_65, 10 * SH, true);
        vm.prank(alice);
        m.withdrawOrder(TICK_65, true, 0);

        vm.prank(bob);
        m.place{value: 10 ether}(TICK_65, 10 * SH, false);
        assertEq(m.ticks(TICK_65).matched, 0, "cancelled order must not fill");
        assertEq(m.noPos(TICK_65, bob), 0);
    }

    function test_withdraw_orders_at_batch() public {
        vm.startPrank(alice);
        m.place{value: 30 ether}(TICK_65, 10 * SH, true);
        m.place(TICK_65, 10 * SH, true);
        m.place(TICK_65, 10 * SH, true);
        uint256 refund = m.withdrawOrdersAt(TICK_65, true);
        vm.stopPrank();
        assertEq(refund, 19.5 ether, "3 x 6.5");
        assertEq(m.ticks(TICK_65).openYes, 0);
    }

    // --------------------------------------------------------- resolution

    function test_only_resolver_resolves() public {
        vm.warp(block.timestamp + 61);
        vm.prank(alice);
        vm.expectRevert(Market.NotYours.selector);
        m.resolve(Market.Outcome.Yes);
    }

    function test_no_resolve_before_resolve_after() public {
        vm.prank(resolver);
        vm.expectRevert(Market.TooEarly.selector);
        m.resolve(Market.Outcome.Yes);
    }

    function test_no_double_resolve() public {
        vm.warp(block.timestamp + 61);
        vm.startPrank(resolver);
        m.resolve(Market.Outcome.Yes);
        vm.expectRevert(Market.AlreadyResolved.selector);
        m.resolve(Market.Outcome.No);
        vm.stopPrank();
    }

    function test_no_claim_before_resolve() public {
        _workedExample();
        vm.prank(alice);
        vm.expectRevert(Market.NotResolved.selector);
        m.claimAll();
    }

    function test_no_double_claim() public {
        _workedExample();
        vm.warp(block.timestamp + 61);
        vm.prank(resolver);
        m.resolve(Market.Outcome.Yes);
        vm.startPrank(alice);
        assertEq(m.claimAll(), 59.4 ether);
        assertEq(m.claimAll(), 0, "second claim pays nothing");
        vm.stopPrank();
    }

    /// SECURITY: matching after the outcome is known would let anyone hand
    /// themselves a winning position out of somebody else's resting order.
    function test_no_matching_after_resolve() public {
        vm.prank(alice);
        m.place{value: 65 ether}(TICK_65, 100 * SH, true);
        vm.warp(block.timestamp + 61);
        vm.prank(resolver);
        m.resolve(Market.Outcome.Yes);

        vm.prank(cranker);
        vm.expectRevert(Market.AlreadyResolved.selector);
        m.matchTick(TICK_65, 10);
    }

    function test_matching_allowed_while_locked() public {
        vm.prank(alice);
        m.place{value: 65 ether}(TICK_65, 100 * SH, true);
        vm.prank(bob);
        m.place{value: 21 ether}(TICK_65, 60 * SH, false);
        vm.warp(block.timestamp + 46); // Locked
        assertEq(uint8(m.phase()), uint8(Market.Phase.Locked));
        vm.prank(cranker);
        m.matchTick(TICK_65, 50); // must not revert
    }

    // ---------------------------------------------------------------- fees

    function test_fee_is_one_percent_and_sweepable() public {
        _workedExample();
        vm.warp(block.timestamp + 61);
        vm.prank(resolver);
        m.resolve(Market.Outcome.Yes);
        vm.prank(alice);
        m.claimAll();

        uint256 sinkBefore = feeSink.balance;
        uint8[] memory all_ = _allTicks();
        uint256 swept = m.sweepFees(all_);

        // 0.60 total fee, 10% of it earmarked for the cranker
        assertEq(swept, 0.54 ether);
        assertEq(feeSink.balance, sinkBefore + 0.54 ether);

        // The crank reward goes to the cranker OF RECORD, which is whoever last
        // did useful matching work -- and in _workedExample that is bob, whose
        // place() auto-matched the whole pair before the dedicated cranker got
        // there. The cranker's own matchTick call filled nothing, and a call
        // that fills nothing does not claim the tick. See
        // test_crank_reward_goes_to_the_address_that_matched, which asserts the
        // same rule directly.
        m.payCrankReward(TICK_65);
        assertEq(m.balance(bob), 0.06 ether, "the address that matched earns the crank slice");
        assertEq(m.balance(cranker), 0, "an idle cranker earns nothing");
    }

    function test_crank_reward_goes_to_the_address_that_matched() public {
        vm.prank(alice);
        m.place{value: 65 ether}(TICK_65, 100 * SH, true);
        vm.prank(bob);
        m.place{value: 21 ether}(TICK_65, 60 * SH, false);
        // bob's place() did the matching, so bob is the cranker of record
        assertEq(m.ticks(TICK_65).cranker, bob);
    }

    // -------------------------------------------------------------- views

    function test_implied_defaults_to_fifty() public view {
        assertEq(m.impliedBps(), 5_000);
    }

    function test_implied_tracks_volume() public {
        vm.prank(alice);
        m.place{value: 65 ether}(TICK_65, 100 * SH, true);
        assertEq(m.impliedBps(), 6_500, "single resting order sets implied");
    }

    function test_open_orders_of_powers_cancel_ui() public {
        vm.startPrank(alice);
        m.place{value: 30 ether}(TICK_65, 10 * SH, true);
        m.place(TICK_65, 20 * SH, true);
        vm.stopPrank();

        (uint32[] memory idx, uint128[] memory rem) = m.openOrdersOf(TICK_65, true, alice);
        assertEq(idx.length, 2);
        assertEq(rem[0], 10 * SH);
        assertEq(rem[1], 20 * SH);
    }

    function test_snapshot_returns_everything_the_app_needs() public {
        _workedExample();
        (, Market.Phase ph,,,, uint256 implied,, Market.Tick[] memory levels,,) = m.snapshot(alice);
        assertEq(uint8(ph), uint8(Market.Phase.Open));
        assertEq(implied, 6_500);
        assertEq(levels.length, 19);
        assertEq(levels[TICK_65].matched, 60 * SH);
    }

    // ------------------------------------------------------------- helpers

    function _allTicks() internal pure returns (uint8[] memory a) {
        a = new uint8[](19);
        for (uint8 i; i < 19; ++i) {
            a[i] = i;
        }
    }
}

contract FactoryAndSeriesTest is Test {
    MarketFactory f;
    address feeSink = address(0xFEE);
    address resolver = address(this);

    function setUp() public {
        f = new MarketFactory(feeSink);
    }

    function test_create_and_recent() public {
        f.create("a?", 45, 60);
        f.create("b?", 45, 60);
        assertEq(f.count(), 2);
        Market[] memory r = f.recent(1);
        assertEq(r.length, 1);
        assertEq(r[0].question(), "b?", "newest first");
    }

    function test_kill_switch_blocks_new_markets_only() public {
        Market live = f.create("a?", 45, 60);
        f.setPaused(true);
        vm.expectRevert(MarketFactory.IsPaused.selector);
        f.create("b?", 45, 60);
        // the live market keeps working
        live.deposit{value: 1 ether}();
    }

    function test_only_owner_creates() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(MarketFactory.NotOwner.selector);
        f.create("a?", 45, 60);
    }

    function test_series_rolls_rounds_permissionlessly() public {
        Series s = new Series("boundary this over?", 45, 60, resolver, feeSink, 100, 1_000);
        assertTrue(s.pokeable());
        vm.prank(address(0xA11CE)); // anyone
        s.poke();
        assertEq(s.count(), 1);
        assertFalse(s.pokeable());

        vm.expectRevert(Series.TooEarly.selector);
        s.poke();

        vm.warp(block.timestamp + 61);
        s.poke();
        assertEq(s.count(), 2);
    }

    function test_series_schedule_does_not_drift() public {
        Series s = new Series("q?", 45, 60, resolver, feeSink, 100, 1_000);
        uint64 t0 = uint64(block.timestamp);
        s.poke();
        assertEq(s.nextStart(), t0 + 60);

        // poke 5 seconds late: the next slot is still on the original grid
        vm.warp(t0 + 65);
        s.poke();
        assertEq(s.nextStart(), t0 + 120, "late poke must not push the grid");
    }

    function test_series_catches_up_after_long_outage() public {
        Series s = new Series("q?", 45, 60, resolver, feeSink, 100, 1_000);
        uint64 t0 = uint64(block.timestamp);
        s.poke();
        vm.warp(t0 + 601); // ten missed rounds
        s.poke();
        assertGt(s.nextStart(), uint64(block.timestamp), "resync, not a burst");
    }
}
