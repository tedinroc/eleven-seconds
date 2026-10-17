// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test, Vm} from "forge-std/Test.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ITransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {GuardedAdmin} from "../src/GuardedAdmin.sol";
import {DemoBTC} from "../src/DemoBTC.sol";
import {DemoBTCV2} from "../src/DemoBTCV2.sol";
import {PausedImpl} from "../src/PausedImpl.sol";
import {EvilMintImpl} from "../src/attack/EvilMintImpl.sol";
import {EvilOwnerImpl} from "../src/attack/EvilOwnerImpl.sol";
import {EvilFeeImpl} from "../src/attack/EvilFeeImpl.sol";

contract GuardedAdminTest is Test {
    uint64 constant DELAY = 30;
    bytes32 constant R1 = keccak256("GUARD/R1_TOTAL_SUPPLY");
    bytes32 constant R3 = keccak256("GUARD/R3_TRANSFER_CONSERVATION");
    bytes32 constant R7 = keccak256("GUARD/R7_CONFIG_GUARD");

    address deployer = makeAddr("deployer");
    address admin = makeAddr("admin");
    address s1 = makeAddr("sentinel1");
    address s2 = makeAddr("sentinel2");
    address s3 = makeAddr("sentinel3");
    address approver = makeAddr("approver");
    address h1 = makeAddr("holder1");
    address h2 = makeAddr("holder2");
    address h3 = makeAddr("holder3");
    address stranger = makeAddr("stranger");

    DemoBTC v1;
    DemoBTCV2 v2;
    EvilMintImpl evilMint;
    EvilOwnerImpl evilOwner;
    EvilFeeImpl evilFee;
    PausedImpl pausedImpl;
    address proxy;
    ProxyAdmin proxyAdmin;
    GuardedAdmin ga;
    DemoBTC token; // the proxy, seen through the v1 ABI

    function setUp() public {
        vm.roll(100);
        vm.startPrank(deployer);
        v1 = new DemoBTC();
        address[] memory holders = new address[](3);
        holders[0] = h1;
        holders[1] = h2;
        holders[2] = h3;
        uint256[] memory amounts = new uint256[](3);
        amounts[0] = 100e8;
        amounts[1] = 50e8;
        amounts[2] = 25e8;
        proxy = address(
            new TransparentUpgradeableProxy(
                address(v1), admin, abi.encodeCall(DemoBTC.initialize, (admin, holders, amounts))
            )
        );
        proxyAdmin = ProxyAdmin(address(uint160(uint256(vm.load(proxy, ERC1967Utils.ADMIN_SLOT)))));
        v2 = new DemoBTCV2();
        evilMint = new EvilMintImpl();
        evilOwner = new EvilOwnerImpl();
        evilFee = new EvilFeeImpl();
        pausedImpl = new PausedImpl();
        ga = new GuardedAdmin(address(proxyAdmin), proxy, admin, _guardians(), approver, address(pausedImpl), DELAY);
        vm.stopPrank();

        // Adoption, exactly as script/Deploy.s.sol: admin hands both ProxyAdmin and the token's Ownable
        // to GuardedAdmin.
        token = DemoBTC(proxy);
        vm.startPrank(admin);
        proxyAdmin.transferOwnership(address(ga));
        token.transferOwnership(address(ga));
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ helpers

    function _guardians() internal view returns (address[] memory g) {
        g = new address[](3);
        g[0] = s1;
        g[1] = s2;
        g[2] = s3;
    }

    function _advance(uint256 n) internal {
        vm.roll(vm.getBlockNumber() + n);
    }

    function _impl() internal view returns (address) {
        return address(uint160(uint256(vm.load(proxy, ERC1967Utils.IMPLEMENTATION_SLOT))));
    }

    function _proposeUpgrade(address impl) internal returns (uint256 id) {
        vm.prank(admin);
        id = ga.proposeUpgrade(impl, "");
    }

    function _status(uint256 id) internal view returns (GuardedAdmin.Status) {
        return ga.getProposal(id).status;
    }

    // ------------------------------------------------------------------ wiring (T6)

    function test_wiring() public view {
        assertTrue(ga.isWired());
        assertEq(proxyAdmin.owner(), address(ga));
        assertEq(ga.proxy(), proxy);
        assertEq(ga.proxyAdmin(), address(proxyAdmin));
        assertEq(ga.owner(), admin);
        assertEq(ga.approver(), approver);
        assertEq(ga.pausedImpl(), address(pausedImpl));
        assertEq(ga.delayBlocks(), DELAY);
        assertEq(ga.guardianCount(), 3);
        assertTrue(ga.isGuardian(s1) && ga.isGuardian(s2) && ga.isGuardian(s3));
        assertEq(ga.nextId(), 1);
        assertFalse(ga.paused());
        assertEq(_impl(), address(v1));
        assertEq(token.symbol(), "dBTC");
        assertEq(token.balanceOf(h1), 100e8);
        assertEq(token.owner(), address(ga));
    }

    function test_T6_adminCannotBypassGuardedAdmin() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, admin));
        proxyAdmin.upgradeAndCall(ITransparentUpgradeableProxy(proxy), address(evilMint), "");
        assertEq(_impl(), address(v1));
        assertTrue(ga.isWired());
    }

    /// A leaked admin key must not be able to mint (or grab the token) without going through a
    /// proposal: the token's Ownable belongs to GuardedAdmin after adoption.
    function test_T6_adminCannotMintDirectly() public {
        uint256 sup = token.totalSupply();
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, admin));
        token.mint(admin, 1_000_000e8);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, admin));
        token.transferOwnership(admin);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, admin));
        token.renounceOwnership();
        vm.stopPrank();
        assertEq(token.totalSupply(), sup);
        assertEq(token.owner(), address(ga));
    }

    /// GuardedAdmin owns the token but has no generic call path, so nobody can reach mint through it.
    function test_T6_tokenOwnerIsGuardedAdmin_noOneMints() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        token.mint(stranger, 1);
        vm.prank(s1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, s1));
        token.mint(s1, 1);
        assertEq(token.totalSupply(), 175e8);
    }

    // ------------------------------------------------------------------ T1: EvilMint vetoed

    function test_T1_evilMintVetoed_executeRevertsProposalVetoed() public {
        uint256 id = _proposeUpgrade(address(evilMint));
        _advance(2);
        vm.prank(s1);
        ga.veto(id, R1);
        assertEq(uint8(_status(id)), uint8(GuardedAdmin.Status.Vetoed));

        _advance(DELAY); // well past readyBlock
        vm.expectRevert(abi.encodeWithSelector(GuardedAdmin.ProposalVetoed.selector, id));
        ga.execute(id);
        assertEq(_impl(), address(v1));
    }

    // ------------------------------------------------------------------ v2: 29 blocks TooEarly, 30 ok

    function test_v2_tooEarlyAt29_executesAt30() public {
        uint256 b0 = vm.getBlockNumber();
        uint256 id = _proposeUpgrade(address(v2));
        GuardedAdmin.Proposal memory p = ga.getProposal(id);
        assertEq(id, 1);
        assertEq(p.readyBlock, b0 + DELAY);
        assertEq(p.proposedBlock, b0);
        assertEq(p.codehash, address(v2).codehash);
        assertEq(p.dataHash, keccak256(""));

        uint256 sup = token.totalSupply();
        uint256 bal1 = token.balanceOf(h1);
        uint256 bal2 = token.balanceOf(h2);
        uint256 bal3 = token.balanceOf(h3);

        vm.roll(b0 + 29);
        vm.expectRevert(abi.encodeWithSelector(GuardedAdmin.TooEarly.selector, id, uint64(b0 + 30), uint64(b0 + 29)));
        ga.execute(id);

        vm.roll(b0 + 30);
        vm.expectEmit(true, false, false, true, address(ga));
        emit GuardedAdmin.Executed(id, stranger);
        vm.prank(stranger); // anyone may execute
        ga.execute(id);

        assertEq(_impl(), address(v2));
        assertEq(DemoBTCV2(proxy).version(), "2");
        assertEq(token.totalSupply(), sup);
        assertEq(token.balanceOf(h1), bal1);
        assertEq(token.balanceOf(h2), bal2);
        assertEq(token.balanceOf(h3), bal3);
        assertEq(token.owner(), address(ga));
        assertEq(uint8(_status(id)), uint8(GuardedAdmin.Status.Executed));

        vm.expectRevert(abi.encodeWithSelector(GuardedAdmin.AlreadyExecuted.selector, id));
        ga.execute(id);
    }

    function test_proposedEvent() public {
        uint256 ready = block.number + DELAY;
        vm.expectEmit(true, true, true, true, address(ga));
        emit GuardedAdmin.Proposed(1, 0, address(v2), 0, hex"", address(v2).codehash, uint64(ready));
        _proposeUpgrade(address(v2));
        assertEq(ga.nextId(), 2);
    }

    function test_upgradeWithInitData() public {
        bytes memory data = abi.encodeCall(DemoBTC.mint, (h1, 1)); // runs as the proxy itself
        vm.prank(admin);
        uint256 id = ga.proposeUpgrade(address(v2), data);
        assertEq(ga.getProposal(id).dataHash, keccak256(data));
        assertEq(ga.getProposalData(id), data);
        _advance(DELAY);
        // mint is onlyOwner; inside upgradeToAndCall msg.sender is the ProxyAdmin -> whole execute reverts
        vm.expectRevert();
        ga.execute(id);
        assertEq(uint8(_status(id)), uint8(GuardedAdmin.Status.Pending));
        assertEq(_impl(), address(v1));
    }

    // ------------------------------------------------------------------ T4 / T5: config changes

    function test_T4_removeGuardian_vetoable_notInstant() public {
        vm.prank(admin);
        uint256 id = ga.proposeSetGuardian(s1, false);
        GuardedAdmin.Proposal memory p = ga.getProposal(id);
        assertEq(uint8(p.kind), uint8(GuardedAdmin.Kind.SetGuardian));
        assertEq(p.target, s1);
        assertEq(p.value, 0);
        assertTrue(ga.isGuardian(s1)); // not removed yet

        vm.expectRevert(abi.encodeWithSelector(GuardedAdmin.TooEarly.selector, id, p.readyBlock, uint64(block.number)));
        ga.execute(id);

        vm.prank(s1); // the guardian being removed can still veto
        ga.veto(id, R7);
        _advance(DELAY);
        vm.expectRevert(abi.encodeWithSelector(GuardedAdmin.ProposalVetoed.selector, id));
        ga.execute(id);
        assertTrue(ga.isGuardian(s1));
        assertEq(ga.guardianCount(), 3);
    }

    function test_T5_shortenDelay_vetoable_notInstant() public {
        vm.prank(admin);
        uint256 id = ga.proposeSetDelay(10);
        assertEq(ga.getProposal(id).value, 10);
        assertEq(ga.delayBlocks(), DELAY);

        vm.expectRevert();
        ga.execute(id); // TooEarly

        vm.prank(s2);
        ga.veto(id, R7);
        _advance(DELAY);
        vm.expectRevert(abi.encodeWithSelector(GuardedAdmin.ProposalVetoed.selector, id));
        ga.execute(id);
        assertEq(ga.delayBlocks(), DELAY);
    }

    function test_T5_cannotProposeDelayBelowMinimum() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(GuardedAdmin.InvalidDelay.selector, uint64(0)));
        ga.proposeSetDelay(0);
    }

    function test_configChanges_executeAfterDelayIfNotVetoed() public {
        address s4 = makeAddr("sentinel4");
        vm.startPrank(admin);
        uint256 add = ga.proposeSetGuardian(s4, true);
        uint256 rm = ga.proposeSetGuardian(s1, false);
        uint256 dl = ga.proposeSetDelay(40);
        uint256 pi = ga.proposeSetPausedImpl(address(v2));
        vm.stopPrank();
        _advance(DELAY);
        ga.execute(add);
        ga.execute(rm);
        ga.execute(dl);
        ga.execute(pi);
        assertTrue(ga.isGuardian(s4));
        assertFalse(ga.isGuardian(s1));
        assertEq(ga.guardianCount(), 3);
        assertEq(ga.delayBlocks(), 40);
        assertEq(ga.pausedImpl(), address(v2));

        // the new delay applies to the next proposal
        uint256 b = vm.getBlockNumber();
        uint256 id = _proposeUpgrade(address(v2));
        assertEq(ga.getProposal(id).readyBlock, b + 40);

        vm.prank(s1);
        vm.expectRevert(GuardedAdmin.NotGuardian.selector);
        ga.veto(id, R1);
    }

    function test_cannotRemoveLastGuardian() public {
        vm.startPrank(admin);
        uint256 a = ga.proposeSetGuardian(s1, false);
        uint256 b = ga.proposeSetGuardian(s2, false);
        uint256 c = ga.proposeSetGuardian(s3, false);
        vm.stopPrank();
        _advance(DELAY);
        ga.execute(a);
        ga.execute(b);
        vm.expectRevert(abi.encodeWithSelector(GuardedAdmin.GuardianBounds.selector, 0));
        ga.execute(c);
        assertTrue(ga.isGuardian(s3));
    }

    function test_proposeSetPausedImpl_requiresCode() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(GuardedAdmin.NoCode.selector, stranger));
        ga.proposeSetPausedImpl(stranger);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(GuardedAdmin.NoCode.selector, stranger));
        ga.proposeUpgrade(stranger, "");
    }

    // ------------------------------------------------------------------ breakGlass

    function test_breakGlass_immediate_thenUnpauseWaits() public {
        vm.expectEmit(true, false, false, true, address(ga));
        emit GuardedAdmin.BrokeGlass(s3, address(pausedImpl));
        vm.prank(s3);
        ga.breakGlass();
        assertTrue(ga.paused());
        assertEq(_impl(), address(pausedImpl));

        // views still work, transfers and mints revert
        assertEq(token.balanceOf(h1), 100e8);
        assertEq(token.totalSupply(), 175e8);
        assertEq(token.owner(), address(ga));
        vm.prank(h1);
        vm.expectRevert(PausedImpl.TokenPaused.selector);
        token.transfer(h2, 1);
        vm.prank(address(ga)); // even the token owner cannot mint while paused
        vm.expectRevert(PausedImpl.TokenPaused.selector);
        token.mint(address(ga), 1);

        vm.prank(admin);
        vm.expectRevert(GuardedAdmin.AlreadyPaused.selector);
        ga.breakGlass();

        // unpause = upgrade back, which waits the full delay
        uint256 b0 = vm.getBlockNumber();
        uint256 id = _proposeUpgrade(address(v2));
        vm.roll(b0 + DELAY - 1);
        vm.expectRevert(
            abi.encodeWithSelector(GuardedAdmin.TooEarly.selector, id, uint64(b0 + DELAY), uint64(b0 + DELAY - 1))
        );
        ga.execute(id);
        assertTrue(ga.paused());

        vm.roll(b0 + DELAY);
        ga.execute(id);
        assertFalse(ga.paused());
        assertEq(_impl(), address(v2));
        vm.prank(h1);
        assertTrue(token.transfer(h2, 1e8));
        assertEq(token.balanceOf(h2), 51e8);
    }

    function test_breakGlass_byOwner() public {
        vm.prank(admin);
        ga.breakGlass();
        assertTrue(ga.paused());
    }

    function test_breakGlass_onlyOwnerOrGuardian() public {
        vm.prank(stranger);
        vm.expectRevert(GuardedAdmin.NotOwnerOrGuardian.selector);
        ga.breakGlass();
        vm.prank(approver);
        vm.expectRevert(GuardedAdmin.NotOwnerOrGuardian.selector);
        ga.breakGlass();
    }

    // ------------------------------------------------------------------ access control

    function test_onlyOwnerProposes() public {
        vm.startPrank(stranger);
        vm.expectRevert(GuardedAdmin.NotOwner.selector);
        ga.proposeUpgrade(address(v2), "");
        vm.expectRevert(GuardedAdmin.NotOwner.selector);
        ga.proposeSetGuardian(stranger, true);
        vm.expectRevert(GuardedAdmin.NotOwner.selector);
        ga.proposeSetDelay(40);
        vm.expectRevert(GuardedAdmin.NotOwner.selector);
        ga.proposeSetPausedImpl(address(v2));
        vm.stopPrank();
        vm.prank(s1); // guardians cannot propose either
        vm.expectRevert(GuardedAdmin.NotOwner.selector);
        ga.proposeUpgrade(address(v2), "");
    }

    function test_onlyGuardianVetoesAndAttaches() public {
        uint256 id = _proposeUpgrade(address(evilMint));
        address[3] memory others = [stranger, admin, approver];
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(others[i]);
            vm.expectRevert(GuardedAdmin.NotGuardian.selector);
            ga.veto(id, R1);
            vm.prank(others[i]);
            vm.expectRevert(GuardedAdmin.NotGuardian.selector);
            ga.attachReason(id, bytes32(uint256(1)));
        }
        assertEq(uint8(_status(id)), uint8(GuardedAdmin.Status.Pending));

        bytes32 report = keccak256(unicode"报告");
        vm.expectEmit(true, false, false, true, address(ga));
        emit GuardedAdmin.ReasonAttached(id, s1, report);
        vm.prank(s1);
        ga.attachReason(id, report);

        vm.prank(s1);
        vm.expectRevert(abi.encodeWithSelector(GuardedAdmin.UnknownProposal.selector, 99));
        ga.attachReason(99, report);
    }

    function test_onlyApproverApprovesCodehash() public {
        bytes32 h = address(v2).codehash;
        address[3] memory others = [stranger, admin, s1];
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(others[i]);
            vm.expectRevert(GuardedAdmin.NotApprover.selector);
            ga.approveCodehash(h);
        }
        assertFalse(ga.isApprovedCodehash(h));
        vm.expectEmit(true, false, false, true, address(ga));
        emit GuardedAdmin.CodehashApproved(h, approver);
        vm.prank(approver);
        ga.approveCodehash(h);
        assertTrue(ga.isApprovedCodehash(h));
    }

    // ------------------------------------------------------------------ veto idempotency

    function test_vetoIdempotent_threeGuardians() public {
        uint256 id = _proposeUpgrade(address(evilFee));
        address[3] memory g = [s1, s2, s3];
        vm.recordLogs();
        for (uint256 i = 0; i < 3; i++) {
            vm.expectEmit(true, true, false, true, address(ga));
            emit GuardedAdmin.Vetoed(id, g[i], R3, i + 1);
            vm.prank(g[i]);
            ga.veto(id, R3);
            assertEq(uint8(_status(id)), uint8(GuardedAdmin.Status.Vetoed));
        }
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(ga) && logs[i].topics[0] == GuardedAdmin.Vetoed.selector) n++;
        }
        assertEq(n, 3);
        assertEq(ga.getProposal(id).vetoCount, 3);

        // the same guardian again: still Vetoed, counted once, event emitted again
        vm.expectEmit(true, true, false, true, address(ga));
        emit GuardedAdmin.Vetoed(id, s1, R3, 3);
        vm.prank(s1);
        ga.veto(id, R3);
        assertEq(ga.getProposal(id).vetoCount, 3);
    }

    function test_vetoExecutedReverts_unknownReverts() public {
        uint256 id = _proposeUpgrade(address(v2));
        _advance(DELAY);
        ga.execute(id);
        vm.prank(s1);
        vm.expectRevert(abi.encodeWithSelector(GuardedAdmin.AlreadyExecuted.selector, id));
        ga.veto(id, R1);

        vm.prank(s1);
        vm.expectRevert(abi.encodeWithSelector(GuardedAdmin.UnknownProposal.selector, 0));
        ga.veto(0, R1);
        vm.expectRevert(abi.encodeWithSelector(GuardedAdmin.UnknownProposal.selector, 7));
        ga.execute(7);
    }

    // ------------------------------------------------------------------ attack impls really misbehave

    /// Same trick as the sentinels' stateOverride: point the live proxy's implementation slot at the
    /// candidate and act as a stranger. The proxy's storage (balances, owner) is untouched.
    function _overrideImpl(address impl) internal {
        vm.store(proxy, ERC1967Utils.IMPLEMENTATION_SLOT, bytes32(uint256(uint160(impl))));
    }

    function test_attack_evilMint_strangerMints() public {
        uint256 sup = token.totalSupply();
        _overrideImpl(address(evilMint));
        vm.prank(stranger);
        token.mint(stranger, 1_000_000e8);
        assertEq(token.totalSupply(), sup + 1_000_000e8);
        assertEq(token.balanceOf(stranger), 1_000_000e8);
    }

    function test_attack_v1_strangerCannotMint() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        token.mint(stranger, 1);
    }

    function test_attack_evilOwner_strangerTakesOwnership() public {
        _overrideImpl(address(evilOwner));
        vm.prank(stranger);
        EvilOwnerImpl(proxy).claimOwner();
        assertEq(token.owner(), stranger);
    }

    function test_attack_evilFee_transferNotConserved() public {
        _overrideImpl(address(evilFee));
        uint256 sup = token.totalSupply();
        uint256 ownerBefore = token.balanceOf(address(ga));
        vm.prank(h1);
        token.transfer(stranger, 10e8);
        assertEq(token.balanceOf(h1), 90e8); // holder lost X
        assertEq(token.balanceOf(stranger), 9e8); // receiver got only 0.9 X
        // 10% skimmed to owner(), which is now GuardedAdmin: the R3 invariant (receiver +X, everyone
        // else on the watchlist unchanged) is still violated, so the sentinels still veto.
        assertEq(token.balanceOf(address(ga)), ownerBefore + 1e8);
        assertEq(token.balanceOf(admin), 0);
        assertEq(token.totalSupply(), sup);
    }

    /// R3 scenario end to end with GuardedAdmin owning the token: the EvilFee skim lands in GuardedAdmin
    /// (stuck there, no call path), the transfer is still not conserved for a fresh receiver, and the
    /// R3 veto keeps the proposal from ever executing.
    function test_T3_evilFee_skimToGuardedAdmin_R3StillHolds_andVetoed() public {
        address receiver = makeAddr("freshReceiver");
        uint256 x = 10e8;
        uint256 snap = vm.snapshotState();
        _overrideImpl(address(evilFee)); // what the sentinels' stateOverride sees
        uint256 h1Before = token.balanceOf(h1);
        uint256 gaBefore = token.balanceOf(address(ga));
        vm.prank(h1);
        token.transfer(receiver, x);
        int256 dHolder = int256(token.balanceOf(h1)) - int256(h1Before);
        int256 dReceiver = int256(token.balanceOf(receiver));
        int256 dOwner = int256(token.balanceOf(address(ga))) - int256(gaBefore);
        assertEq(dHolder, -int256(x));
        assertTrue(dReceiver != int256(x)); // R3 violated
        assertEq(dOwner, int256(x / 10)); // skimmedTo = GuardedAdmin
        vm.revertToState(snap);

        uint256 id = _proposeUpgrade(address(evilFee));
        vm.prank(s2);
        ga.veto(id, R3);
        _advance(DELAY);
        vm.expectRevert(abi.encodeWithSelector(GuardedAdmin.ProposalVetoed.selector, id));
        ga.execute(id);
        assertEq(_impl(), address(v1));
        vm.prank(h1);
        token.transfer(receiver, x);
        assertEq(token.balanceOf(receiver), x); // v1 still conserves
    }

    function test_attack_selectorsUnchanged() public view {
        // EvilMint and EvilFee expose the same mint/transfer selectors as v1, so a selector diff misses them.
        assertGt(address(evilMint).code.length, 0);
        assertGt(address(evilFee).code.length, 0);
        assertTrue(address(evilMint).codehash != address(v1).codehash);
        assertTrue(address(evilFee).codehash != address(v1).codehash);
    }

    function test_implsCannotBeInitialized() public {
        address[] memory hs = new address[](0);
        uint256[] memory am = new uint256[](0);
        vm.expectRevert();
        v1.initialize(stranger, hs, am);
        vm.expectRevert();
        evilMint.initialize(stranger, hs, am);
    }

    // ------------------------------------------------------------------ constructor validation

    function test_constructorValidation() public {
        address[] memory g = _guardians();
        vm.expectRevert(GuardedAdmin.ZeroAddress.selector);
        new GuardedAdmin(address(0), proxy, admin, g, approver, address(pausedImpl), DELAY);
        vm.expectRevert(GuardedAdmin.ZeroAddress.selector);
        new GuardedAdmin(address(proxyAdmin), proxy, admin, g, address(0), address(pausedImpl), DELAY);
        vm.expectRevert(abi.encodeWithSelector(GuardedAdmin.NoCode.selector, stranger));
        new GuardedAdmin(address(proxyAdmin), proxy, admin, g, approver, stranger, DELAY);
        vm.expectRevert(abi.encodeWithSelector(GuardedAdmin.GuardianBounds.selector, 0));
        new GuardedAdmin(address(proxyAdmin), proxy, admin, new address[](0), approver, address(pausedImpl), DELAY);
        address[] memory nine = new address[](9);
        for (uint256 i = 0; i < 9; i++) {
            nine[i] = address(uint160(0x1000 + i));
        }
        vm.expectRevert(abi.encodeWithSelector(GuardedAdmin.GuardianBounds.selector, 9));
        new GuardedAdmin(address(proxyAdmin), proxy, admin, nine, approver, address(pausedImpl), DELAY);
        g[1] = address(0);
        vm.expectRevert(GuardedAdmin.ZeroAddress.selector);
        new GuardedAdmin(address(proxyAdmin), proxy, admin, g, approver, address(pausedImpl), DELAY);
    }

    // ------------------------------------------------------------------ fuzz: delay bounds

    function testFuzz_proposeSetDelay_outOfBounds(uint64 d) public {
        vm.assume(d < ga.MIN_DELAY_BLOCKS() || d > ga.MAX_DELAY_BLOCKS());
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(GuardedAdmin.InvalidDelay.selector, d));
        ga.proposeSetDelay(d);
    }

    function testFuzz_constructor_delayOutOfBounds(uint64 d) public {
        d = uint64(bound(d, 0, type(uint64).max));
        vm.assume(d < 10 || d > 50_400);
        vm.expectRevert(abi.encodeWithSelector(GuardedAdmin.InvalidDelay.selector, d));
        new GuardedAdmin(address(proxyAdmin), proxy, admin, _guardians(), approver, address(pausedImpl), d);
    }

    function testFuzz_proposeSetDelay_inBounds(uint64 d) public {
        d = uint64(bound(d, 10, 50_400));
        vm.prank(admin);
        uint256 id = ga.proposeSetDelay(d);
        assertEq(ga.getProposal(id).value, d);
    }
}
