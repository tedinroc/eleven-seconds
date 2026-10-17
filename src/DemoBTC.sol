// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/// @title DemoBTC (dBTC) v1
/// @notice Demo asset behind a TransparentUpgradeableProxy. Not a real asset.
/// @dev ERC20 + Ownable from OZ upgradeable 5.7.0 (ERC-7201 namespaced storage). Every other demo
///      implementation inherits this contract, so they all share the same storage layout.
contract DemoBTC is Initializable, ERC20Upgradeable, OwnableUpgradeable {
    error LengthMismatch();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_, address[] calldata holders, uint256[] calldata amounts) external initializer {
        __ERC20_init("DemoBTC", "dBTC");
        __Ownable_init(owner_);
        if (holders.length != amounts.length) revert LengthMismatch();
        for (uint256 i = 0; i < holders.length; i++) {
            _mint(holders[i], amounts[i]);
        }
    }

    function decimals() public pure override returns (uint8) {
        return 8;
    }

    function mint(address to, uint256 amount) public virtual onlyOwner {
        _mint(to, amount);
    }
}
