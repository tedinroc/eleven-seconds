// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ITransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/// @title GuardedAdmin
/// @notice Owner of an OZ ProxyAdmin. Every upgrade (and every change to the guard itself) waits
///         `delayBlocks` blocks; any guardian can veto while it waits. `breakGlass` switches the proxy
///         to a pre-registered paused implementation immediately; leaving the paused state is an
///         ordinary upgrade and therefore also waits.
/// @dev Time is measured in block numbers only (never timestamps). The contract does not judge
///      whether a new implementation is good or bad; that is the sentinels' job off-chain.
contract GuardedAdmin {
    // ---------------------------------------------------------------- constants (spec 3.1)
    uint64 public constant MIN_DELAY_BLOCKS = 10;
    uint64 public constant MAX_DELAY_BLOCKS = 50_400;
    uint256 public constant MAX_GUARDIANS = 8;
    uint256 public constant MIN_GUARDIANS = 1;

    // ---------------------------------------------------------------- enums (spec 3.2)
    enum Kind {
        Upgrade,
        SetGuardian,
        SetDelay,
        SetPausedImpl
    }

    enum Status {
        None,
        Pending,
        Vetoed,
        Executed
    }

    struct Proposal {
        Kind kind;
        Status status;
        address proposer;
        address target;
        uint256 value;
        bytes32 codehash;
        bytes32 dataHash;
        uint64 proposedBlock;
        uint64 readyBlock;
        uint256 vetoCount;
    }

    // ---------------------------------------------------------------- events (spec 3.4)
    event Proposed(
        uint256 indexed id,
        uint8 indexed kind,
        address indexed target,
        uint256 value,
        bytes data,
        bytes32 codehash,
        uint64 readyBlock
    );
    event Vetoed(uint256 indexed id, address indexed guardian, bytes32 ruleHash, uint256 vetoCount);
    event Executed(uint256 indexed id, address executor);
    event ReasonAttached(uint256 indexed id, address guardian, bytes32 reportHash);
    event CodehashApproved(bytes32 indexed codehash, address approver);
    event BrokeGlass(address indexed caller, address pausedImpl);
    event GuardianSet(address indexed guardian, bool enabled);

    // ---------------------------------------------------------------- errors (spec 3.5)
    error NotOwner();
    error NotGuardian();
    error NotApprover();
    error NotOwnerOrGuardian();
    error UnknownProposal(uint256 id);
    error TooEarly(uint256 id, uint64 readyBlock, uint64 currentBlock);
    error ProposalVetoed(uint256 id);
    error AlreadyExecuted(uint256 id);
    error InvalidDelay(uint64 value);
    error GuardianBounds(uint256 count);
    error ZeroAddress();
    error NoCode(address target);
    error AlreadyPaused();

    // ---------------------------------------------------------------- immutable wiring
    address public immutable proxyAdmin;
    address public immutable proxy;
    address public immutable owner;
    address public immutable approver;

    // ---------------------------------------------------------------- state
    uint64 public delayBlocks;
    bool public paused;
    address public pausedImpl;
    uint256 public guardianCount;
    uint256 public nextId = 1; // id 0 is reserved for "does not exist"

    mapping(address => bool) public isGuardian;
    mapping(bytes32 => bool) public isApprovedCodehash;
    /// @notice Whether `guardian` has already been counted in `vetoCount` of proposal `id`.
    mapping(uint256 => mapping(address => bool)) public hasVetoed;

    mapping(uint256 => Proposal) private _proposals;
    mapping(uint256 => bytes) private _data;

    // ---------------------------------------------------------------- modifiers
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyGuardian() {
        if (!isGuardian[msg.sender]) revert NotGuardian();
        _;
    }

    constructor(
        address proxyAdmin_,
        address proxy_,
        address owner_,
        address[] memory guardians_,
        address approver_,
        address pausedImpl_,
        uint64 delayBlocks_
    ) {
        if (
            proxyAdmin_ == address(0) || proxy_ == address(0) || owner_ == address(0) || approver_ == address(0)
                || pausedImpl_ == address(0)
        ) revert ZeroAddress();
        if (proxyAdmin_.code.length == 0) revert NoCode(proxyAdmin_);
        if (proxy_.code.length == 0) revert NoCode(proxy_);
        if (pausedImpl_.code.length == 0) revert NoCode(pausedImpl_);
        _checkDelay(delayBlocks_);

        proxyAdmin = proxyAdmin_;
        proxy = proxy_;
        owner = owner_;
        approver = approver_;
        pausedImpl = pausedImpl_;
        delayBlocks = delayBlocks_;

        uint256 count = 0;
        for (uint256 i = 0; i < guardians_.length; i++) {
            address g = guardians_[i];
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (g == address(0)) revert ZeroAddress();
            if (isGuardian[g]) continue; // duplicates are counted once
            isGuardian[g] = true;
            count++;
            emit GuardianSet(g, true);
        }
        if (count < MIN_GUARDIANS || count > MAX_GUARDIANS) revert GuardianBounds(count);
        guardianCount = count;
    }

    // ---------------------------------------------------------------- proposals (owner)

    function proposeUpgrade(address newImpl, bytes calldata data) external onlyOwner returns (uint256 id) {
        if (newImpl.code.length == 0) revert NoCode(newImpl);
        id = _propose(Kind.Upgrade, newImpl, 0, newImpl.codehash, data);
    }

    function proposeSetGuardian(address guardian, bool enabled) external onlyOwner returns (uint256 id) {
        if (guardian == address(0)) revert ZeroAddress();
        id = _propose(Kind.SetGuardian, guardian, enabled ? 1 : 0, bytes32(0), "");
    }

    function proposeSetDelay(uint64 newDelay) external onlyOwner returns (uint256 id) {
        _checkDelay(newDelay);
        id = _propose(Kind.SetDelay, address(0), newDelay, bytes32(0), "");
    }

    function proposeSetPausedImpl(address impl) external onlyOwner returns (uint256 id) {
        if (impl.code.length == 0) revert NoCode(impl);
        id = _propose(Kind.SetPausedImpl, impl, 0, impl.codehash, "");
    }

    // ---------------------------------------------------------------- execute (anyone)

    function execute(uint256 id) external {
        Proposal storage p = _proposals[id];
        Status s = p.status;
        if (s == Status.None) revert UnknownProposal(id);
        if (s == Status.Vetoed) revert ProposalVetoed(id);
        if (s == Status.Executed) revert AlreadyExecuted(id);
        uint64 current = _blockNumber();
        if (current < p.readyBlock) revert TooEarly(id, p.readyBlock, current);

        p.status = Status.Executed; // effects (and the event) before the external call
        emit Executed(id, msg.sender);

        Kind kind = p.kind;
        if (kind == Kind.Upgrade) {
            ProxyAdmin(proxyAdmin).upgradeAndCall(ITransparentUpgradeableProxy(proxy), p.target, _data[id]);
            if (paused) paused = false; // leaving the paused state goes through the delay like any upgrade
        } else if (kind == Kind.SetGuardian) {
            _setGuardian(p.target, p.value == 1);
        } else if (kind == Kind.SetDelay) {
            // forge-lint: disable-next-line(unsafe-typecast)
            delayBlocks = uint64(p.value); // bounded by _checkDelay at propose time
        } else {
            if (p.target.code.length == 0) revert NoCode(p.target);
            pausedImpl = p.target;
        }
    }

    // ---------------------------------------------------------------- guardians

    /// @notice Veto a pending proposal. Idempotent: vetoing an already vetoed proposal keeps the
    ///         status, counts the guardian (once per guardian) and emits the event again.
    function veto(uint256 id, bytes32 ruleHash) external onlyGuardian {
        Proposal storage p = _proposals[id];
        Status s = p.status;
        if (s == Status.None) revert UnknownProposal(id);
        if (s == Status.Executed) revert AlreadyExecuted(id);
        if (s == Status.Pending) p.status = Status.Vetoed;
        if (!hasVetoed[id][msg.sender]) {
            hasVetoed[id][msg.sender] = true;
            p.vetoCount += 1;
        }
        emit Vetoed(id, msg.sender, ruleHash, p.vetoCount);
    }

    function attachReason(uint256 id, bytes32 reportHash) external onlyGuardian {
        if (_proposals[id].status == Status.None) revert UnknownProposal(id);
        emit ReasonAttached(id, msg.sender, reportHash);
    }

    // ---------------------------------------------------------------- approver

    /// @notice Registration only. The contract never uses it to let anything through; strict-mode
    ///         sentinels read it.
    function approveCodehash(bytes32 codehash) external {
        if (msg.sender != approver) revert NotApprover();
        isApprovedCodehash[codehash] = true;
        emit CodehashApproved(codehash, msg.sender);
    }

    // ---------------------------------------------------------------- break glass

    function breakGlass() external {
        if (msg.sender != owner && !isGuardian[msg.sender]) revert NotOwnerOrGuardian();
        if (paused) revert AlreadyPaused();
        paused = true;
        address impl = pausedImpl;
        emit BrokeGlass(msg.sender, impl);
        ProxyAdmin(proxyAdmin).upgradeAndCall(ITransparentUpgradeableProxy(proxy), impl, "");
    }

    // ---------------------------------------------------------------- views

    function getProposal(uint256 id) external view returns (Proposal memory) {
        return _proposals[id];
    }

    /// @notice The exact `data` of a proposal (its keccak256 is `dataHash`).
    function getProposalData(uint256 id) external view returns (bytes memory) {
        return _data[id];
    }

    /// @notice True once the ProxyAdmin's owner has been handed to this contract.
    function isWired() external view returns (bool) {
        return ProxyAdmin(proxyAdmin).owner() == address(this);
    }

    // ---------------------------------------------------------------- internal

    function _propose(Kind kind, address target, uint256 value, bytes32 codehash, bytes memory data)
        internal
        returns (uint256 id)
    {
        id = nextId++;
        uint64 current = _blockNumber();
        uint64 ready = current + delayBlocks;
        _proposals[id] = Proposal({
            kind: kind,
            status: Status.Pending,
            proposer: msg.sender,
            target: target,
            value: value,
            codehash: codehash,
            dataHash: keccak256(data),
            proposedBlock: current,
            readyBlock: ready,
            vetoCount: 0
        });
        if (data.length != 0) _data[id] = data;
        emit Proposed(id, uint8(kind), target, value, data, codehash, ready);
    }

    function _setGuardian(address g, bool enabled) internal {
        if (isGuardian[g] == enabled) {
            emit GuardianSet(g, enabled); // no-op, but observable
            return;
        }
        uint256 count = enabled ? guardianCount + 1 : guardianCount - 1;
        if (count < MIN_GUARDIANS || count > MAX_GUARDIANS) revert GuardianBounds(count);
        isGuardian[g] = enabled;
        guardianCount = count;
        emit GuardianSet(g, enabled);
    }

    function _blockNumber() internal view returns (uint64) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(block.number); // block numbers fit in 64 bits for the lifetime of any chain
    }

    function _checkDelay(uint64 value) internal pure {
        if (value < MIN_DELAY_BLOCKS || value > MAX_DELAY_BLOCKS) revert InvalidDelay(value);
    }
}
