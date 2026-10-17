// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

import {GuardedAdmin} from "../src/GuardedAdmin.sol";
import {DemoBTC} from "../src/DemoBTC.sol";
import {DemoBTCV2} from "../src/DemoBTCV2.sol";
import {PausedImpl} from "../src/PausedImpl.sol";
import {EvilMintImpl} from "../src/attack/EvilMintImpl.sol";
import {EvilOwnerImpl} from "../src/attack/EvilOwnerImpl.sol";
import {EvilFeeImpl} from "../src/attack/EvilFeeImpl.sol";

/// @notice One-shot deployment of the whole demo (spec 3.6):
///   deployer: DemoBTC v1 impl -> TransparentUpgradeableProxy(initialOwner = admin) -> other impls -> GuardedAdmin
///   admin:    ProxyAdmin.transferOwnership(GuardedAdmin)   (the "adoption" step)
/// Run it through script/deploy.sh, which picks the signers and the output file.
///
/// Signers / roles:
///   chain 31337 (anvil): anvil's public test mnemonic, index 0 deployer, 1 admin, 2-4 sentinel1-3,
///                        5 approver, 6-8 holders. No key material is needed.
///   any other chain:     DEPLOYER_PK and ADMIN_PK (exported by script/deploy.sh from key files);
///                        SENTINEL1_ADDR..SENTINEL3_ADDR and APPROVER_ADDR as addresses (or *_PK);
///                        holders default to keyless addresses (nobody can move their dBTC).
/// Output: OUT_JSON (path under ./shared/deployments or ./cache).
contract Deploy is Script {
    string internal constant ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
    uint64 internal constant DEFAULT_DELAY = 30;

    struct Cfg {
        uint256 deployerPk;
        uint256 adminPk;
        address deployer;
        address admin;
        address[] guardians;
        address approver;
        address[] holders;
        uint256[] amounts;
        uint64 delay;
    }

    struct Out {
        address v1;
        address proxy;
        address proxyAdmin;
        address v2;
        address evilMint;
        address evilOwner;
        address evilFee;
        address paused;
        address guardedAdmin;
    }

    function run() external {
        Cfg memory c = _config();
        Out memory o;
        uint256 startBlock = block.number;

        vm.startBroadcast(c.deployerPk);
        o.v1 = address(new DemoBTC());
        bytes memory init = abi.encodeCall(DemoBTC.initialize, (c.admin, c.holders, c.amounts));
        o.proxy = address(new TransparentUpgradeableProxy(o.v1, c.admin, init));
        // The proxy creates its own ProxyAdmin; read it from the ERC-1967 admin slot (OZ constant).
        o.proxyAdmin = address(uint160(uint256(vm.load(o.proxy, ERC1967Utils.ADMIN_SLOT))));
        o.v2 = address(new DemoBTCV2());
        o.evilMint = address(new EvilMintImpl());
        o.evilOwner = address(new EvilOwnerImpl());
        o.evilFee = address(new EvilFeeImpl());
        o.paused = address(new PausedImpl());
        o.guardedAdmin =
            address(new GuardedAdmin(o.proxyAdmin, o.proxy, c.admin, c.guardians, c.approver, o.paused, c.delay));
        vm.stopBroadcast();

        // Adoption: the (current) ProxyAdmin owner hands it to GuardedAdmin, once.
        vm.startBroadcast(c.adminPk);
        ProxyAdmin(o.proxyAdmin).transferOwnership(o.guardedAdmin);
        vm.stopBroadcast();

        require(GuardedAdmin(o.guardedAdmin).isWired(), "not wired");
        require(address(uint160(uint256(vm.load(o.proxy, ERC1967Utils.IMPLEMENTATION_SLOT)))) == o.v1, "impl mismatch");

        _write(c, o, startBlock);
    }

    // ------------------------------------------------------------------ config

    function _config() internal view returns (Cfg memory c) {
        c.delay = uint64(vm.envOr("DELAY_BLOCKS", uint256(DEFAULT_DELAY)));
        c.guardians = new address[](3);
        c.amounts = new uint256[](3);
        c.amounts[0] = 100e8; // dBTC has 8 decimals
        c.amounts[1] = 50e8;
        c.amounts[2] = 25e8;

        if (block.chainid == 31337) {
            c.deployerPk = vm.deriveKey(ANVIL_MNEMONIC, 0);
            c.adminPk = vm.deriveKey(ANVIL_MNEMONIC, 1);
            for (uint32 i = 0; i < 3; i++) {
                c.guardians[i] = vm.addr(vm.deriveKey(ANVIL_MNEMONIC, 2 + i));
            }
            c.approver = vm.addr(vm.deriveKey(ANVIL_MNEMONIC, 5));
            c.holders = new address[](3);
            for (uint32 i = 0; i < 3; i++) {
                c.holders[i] = vm.addr(vm.deriveKey(ANVIL_MNEMONIC, 6 + i));
            }
        } else {
            c.deployerPk = vm.envUint("DEPLOYER_PK");
            c.adminPk = vm.envUint("ADMIN_PK");
            c.guardians[0] = _role("SENTINEL1");
            c.guardians[1] = _role("SENTINEL2");
            c.guardians[2] = _role("SENTINEL3");
            c.approver = _role("APPROVER");
            c.holders = vm.envOr("HOLDERS", ",", new address[](0));
            if (c.holders.length == 0) {
                c.holders = new address[](3);
                for (uint256 i = 0; i < 3; i++) {
                    // Keyless demo holders: the address is a hash, so no private key exists for it.
                    c.holders[i] =
                        address(uint160(uint256(keccak256(abi.encodePacked("eleven-seconds/demo-holder/", i + 1)))));
                }
            }
            require(c.holders.length == 3, "HOLDERS must list 3 addresses");
        }
        c.deployer = vm.addr(c.deployerPk);
        c.admin = vm.addr(c.adminPk);
    }

    function _role(string memory name) internal view returns (address) {
        address a = vm.envOr(string.concat(name, "_ADDR"), address(0));
        if (a != address(0)) return a;
        return vm.addr(vm.envUint(string.concat(name, "_PK")));
    }

    // ------------------------------------------------------------------ output

    function _write(Cfg memory c, Out memory o, uint256 startBlock) internal {
        string memory path = vm.envOr("OUT_JSON", string("cache/deployment.dryrun.json"));

        string memory impls = "impls";
        vm.serializeAddress(impls, "v1", o.v1);
        vm.serializeAddress(impls, "v2", o.v2);
        vm.serializeAddress(impls, "evilMint", o.evilMint);
        vm.serializeAddress(impls, "evilOwner", o.evilOwner);
        vm.serializeAddress(impls, "evilFee", o.evilFee);
        string memory implsJson = vm.serializeAddress(impls, "paused", o.paused);

        string memory hashes = "codehashes";
        vm.serializeBytes32(hashes, "v1", o.v1.codehash);
        vm.serializeBytes32(hashes, "v2", o.v2.codehash);
        vm.serializeBytes32(hashes, "evilMint", o.evilMint.codehash);
        vm.serializeBytes32(hashes, "evilOwner", o.evilOwner.codehash);
        vm.serializeBytes32(hashes, "evilFee", o.evilFee.codehash);
        string memory hashesJson = vm.serializeBytes32(hashes, "paused", o.paused.codehash);

        string memory token = "token";
        vm.serializeString(token, "name", "DemoBTC");
        vm.serializeString(token, "symbol", "dBTC");
        string memory tokenJson = vm.serializeUint(token, "decimals", 8);

        string memory root = "root";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeString(
            root,
            "network",
            block.chainid == 31337 ? "anvil" : block.chainid == 10143 ? "monad-testnet" : vm.toString(block.chainid)
        );
        vm.serializeAddress(root, "guardedAdmin", o.guardedAdmin);
        vm.serializeAddress(root, "proxyAdmin", o.proxyAdmin);
        vm.serializeAddress(root, "proxy", o.proxy);
        vm.serializeString(root, "impls", implsJson);
        vm.serializeString(root, "codehashes", hashesJson);
        vm.serializeString(root, "token", tokenJson);
        vm.serializeAddress(root, "deployer", c.deployer);
        vm.serializeAddress(root, "owner", c.admin);
        vm.serializeAddress(root, "guardians", c.guardians);
        vm.serializeAddress(root, "approver", c.approver);
        vm.serializeAddress(root, "holders", c.holders);
        vm.serializeUint(root, "holderAmounts", c.amounts);
        vm.serializeUint(root, "delayBlocks", c.delay);
        // Simulated block; script/deploy.sh replaces it with the first receipt's block after broadcast.
        string memory json = vm.serializeUint(root, "deployBlock", startBlock);
        vm.writeJson(json, path);
        console2.log("wrote", path);
        console2.log("GuardedAdmin", o.guardedAdmin);
        console2.log("proxy (dBTC)", o.proxy);
    }
}
