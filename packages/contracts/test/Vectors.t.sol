// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Market} from "../src/Market.sol";

/// @title  Cost-parity vectors
/// @notice The order ticket in the browser previews a cost before the user signs.
///         If that preview and the contract ever disagree by a single wei, the user
///         gets charged something they did not agree to and the product loses trust
///         instantly. This test makes that drift impossible to merge.
///
///         test/vectors/cost-vectors.json is the shared contract between the two:
///           - this file proves the SOLIDITY agrees with it
///           - apps/web/lib/market-math.test.ts proves the TYPESCRIPT agrees with it
///
///         Regenerate from the reference model with:  python3 sim/gen_vectors.py
///         Regenerate from this contract with:        forge test --mt test_writeVectors
contract VectorsTest is Test {
    string internal constant VECTORS = "test/vectors/cost-vectors.json";
    string internal constant CONTRACT_COSTS = "test/vectors/contract-costs.json";

    Market internal m;

    function setUp() public {
        // Pricing is `pure`, so the market parameters are irrelevant here. Any
        // instance prices identically; that is the point of keeping cost() pure.
        m = new Market("parity harness", address(this), address(this), 100, 1_000, 45, 60);
    }

    // -------------------------------------------------------------- constants

    function test_constantsMatchVectors() public view {
        string memory json = vm.readFile(VECTORS);
        assertEq(vm.parseJsonUint(json, ".one"), m.ONE(), "ONE drifted");
        assertEq(vm.parseJsonUint(json, ".numTicks"), m.NUM_TICKS(), "NUM_TICKS drifted");
        assertEq(vm.parseUint(vm.parseJsonString(json, ".minShares")), m.MIN_SHARES(), "MIN_SHARES drifted");
    }

    function test_tickPricesMatchVectors() public view {
        string memory json = vm.readFile(VECTORS);
        string[] memory prices = vm.parseJsonStringArray(json, ".tickPrices");
        assertEq(prices.length, m.NUM_TICKS(), "wrong number of ticks");
        for (uint8 i = 0; i < m.NUM_TICKS(); i++) {
            assertEq(m.price(i), vm.parseUint(prices[i]), "tick price drifted");
        }
    }

    // ------------------------------------------------------------------- cost

    /// @notice The main event: every committed cost vector, checked against the
    ///         real contract. Two bulk JSON parses, then pure arithmetic.
    function test_committedVectorsMatchContract() public view {
        string memory json = vm.readFile(VECTORS);
        string[] memory shares = vm.parseJsonStringArray(json, ".shareSamples");
        string[] memory costs = vm.parseJsonStringArray(json, ".costs");

        uint256 expectedCount = shares.length * uint256(m.NUM_TICKS()) * 2;
        assertEq(costs.length, expectedCount, "vector count does not match the documented order");
        assertGt(costs.length, 8_000, "vector file looks truncated");

        // ORDER (must match gen_vectors.py and market-math.test.ts exactly):
        // tick asc -> isYes true then false -> shareSamples index asc.
        uint256 k = 0;
        for (uint8 tick = 0; tick < m.NUM_TICKS(); tick++) {
            for (uint256 leg = 0; leg < 2; leg++) {
                bool isYes = leg == 0;
                for (uint256 j = 0; j < shares.length; j++) {
                    uint128 sh = uint128(vm.parseUint(shares[j]));
                    assertEq(m.cost(tick, sh, isYes), vm.parseUint(costs[k]), "cost mismatch");
                    k++;
                }
            }
        }
        assertEq(k, costs.length, "did not consume every vector");
    }

    /// @notice Writes the cost table straight out of this contract, so the JSON can
    ///         be regenerated from the source of truth rather than from the model.
    function test_writeVectors() public {
        string memory json = vm.readFile(VECTORS);
        string[] memory shares = vm.parseJsonStringArray(json, ".shareSamples");

        string[] memory out = new string[](shares.length * uint256(m.NUM_TICKS()) * 2);
        uint256 k = 0;
        for (uint8 tick = 0; tick < m.NUM_TICKS(); tick++) {
            for (uint256 leg = 0; leg < 2; leg++) {
                bool isYes = leg == 0;
                for (uint256 j = 0; j < shares.length; j++) {
                    out[k] = vm.toString(m.cost(tick, uint128(vm.parseUint(shares[j])), isYes));
                    k++;
                }
            }
        }

        string memory obj = "contractCosts";
        vm.serializeString(obj, "_comment", "Generated from Market.sol by: forge test --mt test_writeVectors");
        vm.serializeString(obj, "_order", "tick asc, then isYes=true then isYes=false, then shareSamples index asc");
        string memory finalJson = vm.serializeString(obj, "costs", out);
        vm.writeJson(finalJson, CONTRACT_COSTS);
    }

    // ------------------------------------------------------------- properties
    // Restated natively so a corrupted vector file cannot make these pass silently.

    function test_legsAlwaysSumToOne() public view {
        for (uint8 tick = 0; tick < m.NUM_TICKS(); tick++) {
            assertEq(m.legPrice(tick, true) + m.legPrice(tick, false), m.ONE(), "legs must sum to 1.00");
        }
    }

    /// @notice The solvency property that justifies rounding every debit UP:
    ///         a matched pair must always hand the contract at least the 1.00 it
    ///         will owe the winner. Checked down to a single wei of shares.
    function test_matchedPairIsNeverUndercollateralised() public view {
        uint128[9] memory sizes =
            [1, 2, 3, 7, 9_999, uint128(1e15), uint128(1e18), uint128(1e18 + 1), uint128(7_777_777_777_777_777)];

        for (uint8 tick = 0; tick < m.NUM_TICKS(); tick++) {
            for (uint256 i = 0; i < sizes.length; i++) {
                uint256 collected = m.cost(tick, sizes[i], true) + m.cost(tick, sizes[i], false);
                assertGe(collected, sizes[i], "INSOLVENT: pair collateral below payout");
                assertLe(collected - sizes[i], 2, "over-collecting more than 1 wei per leg");
            }
        }
    }

    function testFuzz_pairIsNeverUndercollateralised(uint8 tickSeed, uint128 shares) public view {
        uint8 tick = uint8(bound(uint256(tickSeed), 0, uint256(m.NUM_TICKS()) - 1));
        shares = uint128(bound(uint256(shares), 1, type(uint96).max));
        uint256 collected = m.cost(tick, shares, true) + m.cost(tick, shares, false);
        assertGe(collected, shares, "INSOLVENT");
    }

    function testFuzz_costIsMonotonicInSize(uint8 tickSeed, uint128 a, uint128 b) public view {
        uint8 tick = uint8(bound(uint256(tickSeed), 0, uint256(m.NUM_TICKS()) - 1));
        a = uint128(bound(uint256(a), 0, type(uint96).max));
        b = uint128(bound(uint256(b), 0, type(uint96).max));
        if (a > b) (a, b) = (b, a);
        assertLe(m.cost(tick, a, true), m.cost(tick, b, true), "cost must not decrease with size");
    }
}
