// Extended attack fixtures, second set (see Attacks.sol for how to build).
// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;
import {DemoBTC} from "repo/DemoBTC.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

// B1: unguarded mint, selector 0x00dca85e (leading zero byte -> solc emits PUSH3, not PUSH4)
contract EvilZeroSelMint is DemoBTC {
    function mint335(address to, uint256 amount) external { _mint(to, amount); }
}
// B1b: unguarded claimOwner, selector 0x0017fc2f
contract EvilZeroSelOwner is DemoBTC {
    function claim69() external { _transferOwnership(msg.sender); }
}
// B2: unguarded mint with 3 static args (caught by the wide 8-word probe)
contract Evil3ArgMint is DemoBTC {
    function mintTo(address to, uint256 amount, uint256 memo) external { memo; _mint(to, amount); }
}
// B3: anyone can sweep holder funds; supply and owner untouched
contract EvilSweep is DemoBTC {
    address constant VICTIM = 0x976EA74026E726554dB657fA54763abd0C3a0aa9;
    function sweep(address to) external { _transfer(VICTIM, to, balanceOf(VICTIM)); }
}
// B4: control: plain unguarded mint with a normal selector (should be vetoed)
contract EvilControl is DemoBTC {
    function freeMint(address to, uint256 amount) external { _mint(to, amount); }
}
contract P is TransparentUpgradeableProxy {
    constructor(address l, address o, bytes memory d) TransparentUpgradeableProxy(l, o, d) {}
}
