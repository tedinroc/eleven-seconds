// SPDX-License-Identifier: MIT
// Known issues in GuardedAdmin v1, found in the 2026-10-17 post-event review (ids contracts-1 … contracts-7).
// Each test asserts the CURRENT, unsafe behaviour so the weakness stays documented and reproducible.
// When GuardedAdmin v2 fixes one, its test will fail: replace it with a test of the protective behaviour.
// Testnet demo contracts only — see README "Scope".
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

import {GuardedAdmin} from "../../src/GuardedAdmin.sol";
import {DemoBTC} from "../../src/DemoBTC.sol";
import {DemoBTCV2} from "../../src/DemoBTCV2.sol";
import {PausedImpl} from "../../src/PausedImpl.sol";
import {EvilFeeImpl} from "../../src/attack/EvilFeeImpl.sol";

contract DemoBTCV3 is DemoBTC {
    function version() external pure returns (string memory) {
        return "3";
    }
}

/// Reinitializer-style impl: the approved codehash says nothing about who the init args name.
contract DemoBTCV2Init is DemoBTC {
    function initializeV2(address newOwner) external reinitializer(2) {
        _transferOwnership(newOwner);
    }
}

contract KnownIssuesTest is Test {
    uint64 constant DELAY = 30;
    bytes32 constant R7 = keccak256("GUARD/R7_CONFIG_GUARD");
    address deployer = makeAddr("deployer");
    address admin = makeAddr("admin");
    address s1 = makeAddr("sentinel1");
    address s2 = makeAddr("sentinel2");
    address s3 = makeAddr("sentinel3");
    address approver = makeAddr("approver");
    address h1 = makeAddr("holder1");
    address h2 = makeAddr("holder2");
    address stranger = makeAddr("stranger");

    DemoBTC v1;
    DemoBTCV2 v2;
    DemoBTCV3 v3;
    EvilFeeImpl evilFee;
    PausedImpl pausedImpl;
    address proxy;
    ProxyAdmin proxyAdmin;
    GuardedAdmin ga;
    DemoBTC token;

    function setUp() public {
        vm.roll(100);
        vm.startPrank(deployer);
        v1 = new DemoBTC();
        address[] memory holders = new address[](2);
        holders[0] = h1;
        holders[1] = h2;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 100e8;
        amounts[1] = 50e8;
        proxy = address(
            new TransparentUpgradeableProxy(address(v1), admin, abi.encodeCall(DemoBTC.initialize, (admin, holders, amounts)))
        );
        proxyAdmin = ProxyAdmin(address(uint160(uint256(vm.load(proxy, ERC1967Utils.ADMIN_SLOT)))));
        v2 = new DemoBTCV2();
        v3 = new DemoBTCV3();
        evilFee = new EvilFeeImpl();
        pausedImpl = new PausedImpl();
        address[] memory g = new address[](3);
        g[0] = s1;
        g[1] = s2;
        g[2] = s3;
        ga = new GuardedAdmin(address(proxyAdmin), proxy, admin, g, approver, address(pausedImpl), DELAY);
        vm.stopPrank();
        token = DemoBTC(proxy);
        vm.startPrank(admin);
        proxyAdmin.transferOwnership(address(ga));
        token.transferOwnership(address(ga));
        vm.stopPrank();
    }

    function _impl() internal view returns (address) {
        return address(uint160(uint256(vm.load(proxy, ERC1967Utils.IMPLEMENTATION_SLOT))));
    }

    /// A matured, never-executed Upgrade proposal lets ANYONE undo breakGlass in the same block.
    function test_knownIssue_staleProposalUndoesBreakGlassInstantly() public {
        vm.prank(admin);
        uint256 stale = ga.proposeUpgrade(address(v1), ""); // benign, sentinels pass, nobody executes
        vm.roll(block.number + 5000); // long matured

        vm.prank(s1);
        ga.breakGlass(); // incident: guardians freeze the token
        assertTrue(ga.paused());

        vm.prank(stranger); // same block, no key at all
        ga.execute(stale);
        assertFalse(ga.paused());
        assertEq(_impl(), address(v1));
        vm.prank(h1);
        assertTrue(token.transfer(h2, 1e8)); // unfrozen, zero blocks of delay
    }

    /// Proposals never expire and execute order is free: anyone can roll back to an older impl.
    function test_knownIssue_staleProposalRollback() public {
        vm.startPrank(admin);
        uint256 pOld = ga.proposeUpgrade(address(v2), "");
        uint256 pNew = ga.proposeUpgrade(address(v3), "");
        vm.stopPrank();
        vm.roll(block.number + DELAY);
        ga.execute(pNew);
        assertEq(_impl(), address(v3));
        vm.roll(block.number + 100_000);
        vm.prank(stranger);
        ga.execute(pOld); // downgrade, months later, by anyone
        assertEq(_impl(), address(v2));
    }

    /// One rogue guardian (1 of 3 hot sentinel keys): pause, then veto every exit forever.
    function test_knownIssue_singleGuardianPermanentFreeze() public {
        vm.prank(s3);
        ga.breakGlass();
        for (uint256 round = 0; round < 5; round++) {
            vm.startPrank(admin);
            uint256 unpause = ga.proposeUpgrade(address(v1), "");
            uint256 removeS3 = ga.proposeSetGuardian(s3, false);
            vm.stopPrank();
            vm.startPrank(s3);
            ga.veto(unpause, bytes32(0));
            ga.veto(removeS3, bytes32(0));
            vm.stopPrank();
            vm.roll(block.number + DELAY);
            vm.expectRevert(abi.encodeWithSelector(GuardedAdmin.ProposalVetoed.selector, unpause));
            ga.execute(unpause);
            vm.expectRevert(abi.encodeWithSelector(GuardedAdmin.ProposalVetoed.selector, removeS3));
            ga.execute(removeS3);
        }
        assertTrue(ga.paused());
        assertTrue(ga.isGuardian(s3));
        vm.prank(h1);
        vm.expectRevert(PausedImpl.TokenPaused.selector);
        token.transfer(h2, 1);
    }

    /// Stolen owner key (immutable, cannot be rotated): re-pause right after every legitimate unpause.
    function test_knownIssue_stolenOwnerRepausesForever() public {
        for (uint256 round = 0; round < 3; round++) {
            vm.prank(admin); // attacker copy of the key
            ga.breakGlass();
            vm.prank(admin); // team copy of the key
            uint256 id = ga.proposeUpgrade(address(v1), "");
            vm.roll(block.number + DELAY);
            ga.execute(id);
            assertFalse(ga.paused());
        }
        vm.prank(admin);
        ga.breakGlass(); // same block as the last unpause
        assertTrue(ga.paused());
    }

    /// Raising the delay is "not weakening" for R7 (sentinel/src/main.mjs:262), so it passes; the attacker
    /// then makes every legitimate unpause wait MAX_DELAY_BLOCKS while re-pausing at will.
    function test_knownIssue_raiseDelayThenPause() public {
        vm.prank(admin);
        uint256 id = ga.proposeSetDelay(50_400);
        vm.roll(block.number + DELAY);
        ga.execute(id);
        vm.prank(admin);
        ga.breakGlass();
        vm.prank(admin);
        uint256 unpause = ga.proposeUpgrade(address(v1), "");
        assertEq(ga.getProposal(unpause).readyBlock, block.number + 50_400);
    }

    /// The codehash approval (and the sentinel R8 key) bind code+data, but nothing on chain does; and
    /// init data runs with msg.sender = ProxyAdmin: reinitializer args are attacker-chosen.
    function test_knownIssue_initDataReinitializerHandsOwnership() public {
        DemoBTCV2Init vi = new DemoBTCV2Init();
        vm.prank(admin);
        uint256 id = ga.proposeUpgrade(address(vi), abi.encodeCall(DemoBTCV2Init.initializeV2, (stranger)));
        vm.roll(block.number + DELAY);
        ga.execute(id); // no on-chain check of approver, data, or codehash
        assertEq(token.owner(), stranger);
    }

    /// ProxyAdmin ownership can never leave GuardedAdmin: no migration path.
    function test_knownIssue_noMigrationPath() public view {
        assertEq(proxyAdmin.owner(), address(ga));
        // GuardedAdmin exposes no call to ProxyAdmin.transferOwnership and owner/approver are immutable.
        assertEq(ga.owner(), admin);
    }
}
