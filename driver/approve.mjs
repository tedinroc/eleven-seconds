// One-shot codehash approval with the approver key. The key is read only for this transaction, so the
// long-running driver does not have to hold it (2026-10-17 review, finding engineering-4).
//
//   DEPLOYMENT=10143 KEY_DIR=… DRIVER_BROADCAST=1 node driver/approve.mjs --card v2
//   DEPLOYMENT=10143 APPROVER_KEY_FILE=… DRIVER_BROADCAST=1 node driver/approve.mjs --codehash 0x…
//
// Same environment as the driver: DEPLOYMENT, RPC_URLS, BROADCAST_RPCS, APPROVER_KEY_FILE or KEY_DIR,
// DRIVER_BROADCAST=1 (required on a real chain). Prints the plan, preflights with eth_call, and sends
// only after you type "yes".
import readline from 'node:readline/promises'
import { encodeFunctionData, keccak256 } from 'viem'
import { decodeRevert, gasLimit, guardedAdminAbi, isContractAnswer, loadAccount, loadDeployment, RpcPool, shortErr, Signer, waitReceipt } from './lib.mjs'

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}
const list = (s) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean)
const fail = (msg) => {
  console.error(`approve: ${msg}`)
  process.exit(1)
}

const DEPLOYMENT = process.env.DEPLOYMENT ?? 'anvil'
const isAnvil = DEPLOYMENT === 'anvil'
const TESTNET = ['https://rpc.ankr.com/monad_testnet', 'https://testnet-rpc.monad.xyz', 'https://rpc-testnet.monadinfra.com']
const RPC_URLS = list(process.env.RPC_URLS).length ? list(process.env.RPC_URLS) : isAnvil ? ['http://127.0.0.1:8545'] : TESTNET
const BROADCAST_RPCS = list(process.env.BROADCAST_RPCS).length ? list(process.env.BROADCAST_RPCS) : isAnvil ? RPC_URLS.slice(0, 1) : TESTNET

const card = arg('card')
let codehash = arg('codehash')
if (!card && !codehash) fail('give --card <evilMint|evilOwner|evilFee|v2|v1> or --codehash 0x…')

const read = new RpcPool('read', RPC_URLS, { timeout: Number(process.env.RPC_TIMEOUT_MS ?? 3000) })
const send = new RpcPool('send', BROADCAST_RPCS, { timeout: Number(process.env.SEND_TIMEOUT_MS ?? 6000) })
const rc = read.client
const chainId = await rc.getChainId()
if (chainId !== 31337 && process.env.DRIVER_BROADCAST !== '1') fail(`chainId ${chainId}: set DRIVER_BROADCAST=1 to send on a real chain`)
const d = loadDeployment(DEPLOYMENT)
if (!d) fail(`shared/deployments/${DEPLOYMENT}.json not found`)
if (Number(d.chainId) !== chainId) fail(`deployment chainId ${d.chainId} does not match RPC chainId ${chainId}`)

if (!codehash) {
  const impl = d.impls?.[card]
  if (!impl) fail(`unknown card ${card}`)
  const code = await rc.getCode({ address: impl })
  if (!code || code === '0x') fail(`${impl} has no code`)
  codehash = keccak256(code)
}
if (!/^0x[0-9a-fA-F]{64}$/.test(codehash)) fail('codehash must be 0x + 64 hex')

const approver = loadAccount('APPROVER', 'approver', 5, chainId)
if (!approver) fail('no approver key (set APPROVER_KEY_FILE or KEY_DIR)')
if (d.approver && approver.address.toLowerCase() !== String(d.approver).toLowerCase()) fail(`key ${approver.address} is not the deployment's approver ${d.approver}`)

const abi = guardedAdminAbi()
const data = encodeFunctionData({ abi, functionName: 'approveCodehash', args: [codehash] })
try {
  await rc.call({ account: approver.address, to: d.guardedAdmin, data })
} catch (e) {
  if (!isContractAnswer(e)) fail(`preflight failed on every RPC: ${shortErr(e)}`)
  fail(`preflight reverted: ${decodeRevert(e, abi).name ?? shortErr(e)}`)
}

console.log(`chain ${chainId}  GuardedAdmin ${d.guardedAdmin}\napprover ${approver.address}\napproveCodehash(${codehash})${card ? `  (card ${card})` : ''}`)
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const answer = (await rl.question('Type yes to send: ')).trim()
rl.close()
if (answer !== 'yes') fail('not sent')

const blk = await rc.getBlock({ blockTag: 'latest' })
const tip = await rc.request({ method: 'eth_maxPriorityFeePerGas' }).then(BigInt).catch(() => 2_000_000_000n)
const base = blk.baseFeePerGas ?? (await rc.getGasPrice())
const signer = new Signer(approver, chainId, rc, send)
const { hash } = await signer.send({ to: d.guardedAdmin, data, gas: gasLimit('approveCodehash'), fees: { maxFeePerGas: base * 2n + tip, maxPriorityFeePerGas: tip } })
const rcpt = await waitReceipt(rc, hash)
console.log(`${rcpt.status} tx ${hash} block ${rcpt.blockNumber}`)
process.exit(rcpt.status === 'success' ? 0 : 1)
