// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {DemoBTC} from "../DemoBTC.sol";

/// @title EvilOwnerImpl (demo attack, threat T2)
/// @notice Adds `claimOwner()` with no access control: anyone can take ownership.
/// @dev Deliberately malicious demo code. Never deploy outside a demo.
contract EvilOwnerImpl is DemoBTC {
    function claimOwner() external {
        _transferOwnership(msg.sender);
    }
}
