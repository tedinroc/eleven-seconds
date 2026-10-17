// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {DemoBTC} from "./DemoBTC.sol";

/// @title DemoBTC v2
/// @notice The legitimate upgrade: identical to v1 plus `version()`.
contract DemoBTCV2 is DemoBTC {
    function version() external pure returns (string memory) {
        return "2";
    }
}
