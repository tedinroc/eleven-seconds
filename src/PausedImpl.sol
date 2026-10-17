// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {DemoBTC} from "./DemoBTC.sol";

/// @title PausedImpl
/// @notice Break-glass target. Same storage layout as DemoBTC; views keep working, every balance
///         change (transfer, transferFrom, mint, burn) reverts with TokenPaused().
contract PausedImpl is DemoBTC {
    error TokenPaused();

    function _update(address from, address to, uint256 value) internal override {
        // ERC20 never calls _update with both ends zero, so this always reverts in practice.
        if (from != address(0) || to != address(0)) revert TokenPaused();
        super._update(from, to, value);
    }
}
