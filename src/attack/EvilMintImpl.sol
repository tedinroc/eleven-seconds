// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {DemoBTC} from "../DemoBTC.sol";

/// @title EvilMintImpl (demo attack, threat T1)
/// @notice Same selectors as DemoBTC v1, but `mint` has no access control: anyone can mint.
/// @dev Deliberately malicious demo code. Never deploy outside a demo.
contract EvilMintImpl is DemoBTC {
    function mint(address to, uint256 amount) public override {
        _mint(to, amount);
    }
}
