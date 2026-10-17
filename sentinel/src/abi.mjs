// ABIs: shared/abi/*.json (exported by the contracts line) when present, otherwise the minimal
// fragments below, written from the frozen signatures in spec 3.3-3.6.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseAbi } from 'viem'

const GUARDED_ADMIN_MIN = parseAbi([
  'event Proposed(uint256 indexed id, uint8 indexed kind, address indexed target, uint256 value, bytes data, bytes32 codehash, uint64 readyBlock)',
  'event Vetoed(uint256 indexed id, address indexed guardian, bytes32 ruleHash, uint256 vetoCount)',
  'event Executed(uint256 indexed id, address executor)',
  'event ReasonAttached(uint256 indexed id, address guardian, bytes32 reportHash)',
  'function veto(uint256 id, bytes32 ruleHash)',
  'function attachReason(uint256 id, bytes32 reportHash)',
  'function nextId() view returns (uint256)',
  'function isGuardian(address) view returns (bool)',
  'function delayBlocks() view returns (uint64)',
  'function isApprovedCodehash(bytes32) view returns (bool)',
  'function proxy() view returns (address)',
  'function getProposal(uint256 id) view returns ((uint8 kind, uint8 status, address proposer, address target, uint256 value, bytes32 codehash, bytes32 dataHash, uint64 proposedBlock, uint64 readyBlock, uint256 vetoCount))',
  'function getProposalData(uint256 id) view returns (bytes)',
  'error NotGuardian()',
  'error UnknownProposal(uint256 id)',
  'error AlreadyExecuted(uint256 id)',
])

const TOKEN_MIN = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function owner() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)',
])

function loadAbi(sharedDir, name, fallback, log) {
  const p = sharedDir && join(sharedDir, 'abi', `${name}.json`)
  if (p && existsSync(p)) {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    const abi = Array.isArray(j) ? j : j.abi
    log?.info?.(`abi: ${name} from shared/abi`)
    // Keep any minimal entries the exported ABI lacks (e.g. events we decode for attribution).
    const names = new Set(abi.map((x) => `${x.type}:${x.name}`))
    return [...abi, ...fallback.filter((x) => !names.has(`${x.type}:${x.name}`))]
  }
  log?.warn?.(`abi: ${name} not in shared/abi, using minimal fragment`)
  return fallback
}

export function loadAbis(sharedDir, log) {
  return {
    guardedAdmin: loadAbi(sharedDir, 'GuardedAdmin', GUARDED_ADMIN_MIN, log),
    token: loadAbi(sharedDir, 'DemoBTC', TOKEN_MIN, log),
  }
}
