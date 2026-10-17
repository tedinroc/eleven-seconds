// Security-review bypass fixtures (regression for test/e2e-bypass.mjs). Not part of the repo build:
// compile them in a scratch foundry project whose remappings map `repo/` to this repo's src/ (plus
// the usual @openzeppelin / forge-std remappings), then pass its out dir as BYPASS_OUT.
// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;
import {DemoBTC} from "repo/DemoBTC.sol";

/// transferFrom without allowance check: same selectors as v1, supply/owner/transfer all untouched.
contract EvilTransferFromImpl is DemoBTC {
    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        _transfer(from, to, value);
        return true;
    }
}

/// mint is open only after a fixed block (time bomb). Sim runs at latest+1, so it is still closed.
contract TimeBombMintImpl is DemoBTC {
    uint256 public immutable trigger;
    constructor(uint256 t) { trigger = t; }
    function mint(address to, uint256 amount) public override {
        if (block.number < trigger) _checkOwner();
        _mint(to, amount);
    }
}

/// mint is open only when an attacker-controlled external flag is on (flipped after execute).
interface IFlag { function on() external view returns (bool); }
contract Flag { bool public on; function set(bool v) external { on = v; } }
contract FlagMintImpl is DemoBTC {
    IFlag public immutable flag;
    constructor(IFlag f) { flag = f; }
    function mint(address to, uint256 amount) public override {
        if (!flag.on()) _checkOwner();
        _mint(to, amount);
    }
}

/// mint is open only for one hard-coded tx.origin (the attacker EOA); a random stranger is refused.
contract OriginMintImpl is DemoBTC {
    address public immutable boss;
    constructor(address b) { boss = b; }
    function mint(address to, uint256 amount) public override {
        if (tx.origin != boss) _checkOwner();
        _mint(to, amount);
    }
}

/// 3-argument backdoor: probes only ever send <= 2 words of args, so the ABI decoder reverts first.
contract ThreeArgMintImpl is DemoBTC {
    function rescue(address to, uint256 amount, uint256 /*memo*/) external {
        _mint(to, amount);
    }
}

/// A legitimate-looking release with a re-initializer (very common pattern).
contract V2Init is DemoBTC {
    function initializeV2(address newOwner) external reinitializer(2) {
        _transferOwnership(newOwner);
    }
}

contract V2Init3 is DemoBTC {
    function initializeV2(address newOwner, uint256, uint256) external reinitializer(2) {
        _transferOwnership(newOwner);
    }
}
