// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ConflictHarness} from "./ConflictHarness.sol";
import {Market} from "../src/Market.sol";

/// Dumps the slots vm.accesses() actually reported, so the TypeScript core can be
/// held to the same input rather than to a hand-written model of it.
///
///   forge test --mt test_exportMatchTickAccesses
contract ExportAccessesTest is ConflictHarness {
    uint8 constant TICKS = 19;
    uint128 constant SH = 1e18;

    function test_exportMatchTickAccesses() public {
        Market m = new Market("export", address(this), address(this), 100, 1_000, 3_000, 6_000);
        m.deposit{value: 400 ether}();
        for (uint8 t; t < TICKS; ++t) {
            m.place(t, SH, true);
            m.place(t, SH, false);
        }

        string memory arr = "[";
        for (uint8 t; t < TICKS; ++t) {
            vm.record();
            m.matchTick(t, 8);
            (bytes32[] memory reads, bytes32[] memory writes) = vm.accesses(address(m));

            string memory obj = string.concat('{"tx":"match-', vm.toString(uint256(t)), '","sender":"0x');
            obj = string.concat(obj, vm.toString(uint256(t)), '","reads":[', _slots(address(m), reads), '],"writes":[');
            obj = string.concat(obj, _slots(address(m), writes), "]}");

            arr = string.concat(arr, obj, t + 1 < TICKS ? "," : "");
        }
        arr = string.concat(arr, "]");

        vm.writeFile("./test/accesses/matchtick-19.json", arr);
    }

    function _slots(address who, bytes32[] memory ss) internal view returns (string memory out) {
        for (uint256 i; i < ss.length; ++i) {
            out = string.concat(out, '"', vm.toString(who), ":", vm.toString(ss[i]), '"');
            if (i + 1 < ss.length) out = string.concat(out, ",");
        }
    }

    receive() external payable {}
}
