// Approval keys looked up with GuardedAdmin.isApprovedCodehash (sentinel-side convention; the
// contract interface is unchanged, the approver just approves these bytes32 values).
//  - config proposals (kinds 1-3, R7): keccak256(abi.encode(uint8 kind, address target, uint256 value))
//  - upgrade with non-empty init data (R8): keccak256(abi.encode(bytes32 codehash, bytes32 keccak256(data)))
//  - upgrade codehash (R5 strict, R9 exemption): the codehash itself
import { encodeAbiParameters, keccak256 } from 'viem'

export const actionHash = (kind, target, value) =>
  keccak256(encodeAbiParameters([{ type: 'uint8' }, { type: 'address' }, { type: 'uint256' }], [Number(kind), target, BigInt(value)]))

export const upgradeDataKey = (codehash, data) =>
  keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [codehash, keccak256(data)]))

export const approvalKeyFor = (p) => actionHash(p.kind, p.target, p.value)
