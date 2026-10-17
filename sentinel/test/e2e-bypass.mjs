#!/usr/bin/env node
// Regression e2e for the security-review bypasses (anvil only, anvil's public test accounts).
// Needs three running sentinels and the compiled fixture contracts of test/fixtures/Bypass.sol
// (build them in any foundry project that maps `repo/` to this repo's src/, see the header there):
//
//   RPC_URL=http://127.0.0.1:8587 DEPLOYMENTS=<deploy.json> SSE_PORTS=8741,8742,8743 \
//     BYPASS_OUT=<forge out dir> node test/e2e-bypass.mjs
//
// Every bypass implementation (and the config / init-data proposals) must be vetoed by every live
// sentinel with the expected rule, before readyBlock. Also checks the /attach gate on the first port.
import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createPublicClient, createWalletClient, http, encodeFunctionData, keccak256, toHex } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { REPO_ROOT } from '../src/config.mjs'
import { actionHash } from '../src/keys.mjs'
import { sleep } from '../src/util.mjs'

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8545'
const dep = JSON.parse(readFileSync(resolve(REPO_ROOT, process.env.DEPLOYMENTS ?? 'shared/deployments/anvil.json'), 'utf8'))
const PORTS = (process.env.SSE_PORTS ?? '8701,8702,8703').split(',').map(Number)
const OUT = process.env.BYPASS_OUT
if (!OUT || !existsSync(join(OUT, 'Bypass.sol'))) throw new Error('set BYPASS_OUT to a forge out dir containing Bypass.sol/*.json')
const gaAbi = JSON.parse(readFileSync(resolve(REPO_ROOT, 'shared/abi/GuardedAdmin.json'), 'utf8'))
const gas = JSON.parse(readFileSync(resolve(REPO_ROOT, 'shared/gas.json'), 'utf8'))

const MN = 'test test test test test test test test test test test junk'
const deployer = mnemonicToAccount(MN, { addressIndex: 0 })
const admin = mnemonicToAccount(MN, { addressIndex: 1 })
const chain = { ...foundry, id: dep.chainId }
const pub = createPublicClient({ chain, transport: http(RPC_URL), pollingInterval: 100 })
const asDeployer = createWalletClient({ chain, transport: http(RPC_URL), account: deployer })
const asAdmin = createWalletClient({ chain, transport: http(RPC_URL), account: admin })
if ((await pub.getChainId()) !== 31337) throw new Error('e2e runs on anvil only')

const events = []
const live = new Map()
for (const port of PORTS) {
  ;(async () => {
    const res = await fetch(`http://127.0.0.1:${port}/events`)
    live.set(port, true)
    const dec = new TextDecoder()
    let buf = ''
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true })
      let k
      while ((k = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, k)
        buf = buf.slice(k + 2)
        if (frame.startsWith('data: ')) events.push({ port, ...JSON.parse(frame.slice(6)) })
      }
    }
    live.set(port, false)
  })().catch(() => live.set(port, false))
}
await sleep(500)
const n = [...live.values()].filter(Boolean).length
const evs = (id, type) => events.filter((e) => e.id === id && e.type === type)
const waitFor = async (pred, ms, what) => {
  const t = Date.now()
  while (Date.now() - t < ms) {
    if (pred()) return
    await sleep(50)
  }
  throw new Error(`timeout waiting for ${what}`)
}

const art = (file, name) => JSON.parse(readFileSync(join(OUT, file, `${name}.json`), 'utf8'))
async function deploy(file, name, args = []) {
  const a = art(file, name)
  const hash = await asDeployer.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args, gas: 8_000_000n })
  const r = await pub.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error(`deploy ${name} failed`)
  return r.contractAddress
}
async function propose(functionName, args) {
  const id = Number(await pub.readContract({ address: dep.guardedAdmin, abi: gaAbi, functionName: 'nextId' }))
  const hash = await asAdmin.writeContract({ address: dep.guardedAdmin, abi: gaAbi, functionName, args, gas: BigInt(gas.propose.gasLimit) * 4n })
  const r = await pub.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error(`${functionName} reverted`)
  return id
}

const latest = Number(await pub.getBlockNumber())
const flag = await deploy('Bypass.sol', 'Flag')
const cases = [
  ['EvilTransferFromImpl', 'Bypass.sol', [], 'R3B_THIRD_PARTY_FUNDS'],
  ['TimeBombMintImpl', 'Bypass.sol', [BigInt(latest + 100_000)], 'R9_NEW_OPCODES'],
  ['FlagMintImpl', 'Bypass.sol', [flag], 'R9_NEW_OPCODES'],
  ['OriginMintImpl', 'Bypass.sol', [toHex(crypto.getRandomValues(new Uint8Array(20)))], 'R9_NEW_OPCODES'],
  ['ThreeArgMintImpl', 'Bypass.sol', [], 'R1_TOTAL_SUPPLY'],
  ['V2Init', 'Bypass.sol', [], 'R2_OWNER'],
  ['V2Init3', 'Bypass.sol', [], 'R2_OWNER'],
]
if (existsSync(join(OUT, 'Evil.sol'))) {
  cases.push(
    ['EvilZeroSelMint', 'Evil.sol', [], 'R1_TOTAL_SUPPLY'],
    ['EvilZeroSelOwner', 'Evil.sol', [], 'R2_OWNER'],
    ['Evil3ArgMint', 'Evil.sol', [], 'R1_TOTAL_SUPPLY'],
    ['EvilControl', 'Evil.sol', [], 'R1_TOTAL_SUPPLY'],
  )
  // EvilSweep hard-codes anvil account 6 as its victim, which is holders[0] in the anvil deployment.
  if (dep.holders.map((h) => (h.address ?? h).toLowerCase()).includes('0x976ea74026e726554db657fa54763abd0c3a0aa9')) cases.push(['EvilSweep', 'Evil.sol', [], 'R3B_THIRD_PARTY_FUNDS'])
}

const props = []
for (const [name, file, args, rule] of cases) {
  const impl = await deploy(file, name, args)
  props.push({ name, rule, id: await propose('proposeUpgrade', [impl, '0x']) })
}
// R7: adding a guardian is weakening; SetPausedImpl's key is actionHash(3, target, 0), not the codehash.
const rogue = toHex(crypto.getRandomValues(new Uint8Array(20)))
props.push({ name: 'addGuardian', rule: 'R7_CONFIG_GUARD', id: await propose('proposeSetGuardian', [rogue, true]), key: actionHash(1, rogue, 1n) })
props.push({ name: 'setPausedImpl', rule: 'R7_CONFIG_GUARD', id: await propose('proposeSetPausedImpl', [dep.impls.paused]), key: actionHash(3, dep.impls.paused.toLowerCase(), 0n) })
// R8: v2 with init data (v2's codehash may be approved; the data key is not).
props.push({ name: 'v2+data', rule: 'R8_INIT_DATA', id: await propose('proposeUpgrade', [dep.impls.v2, '0x1234']) })

let failures = 0
for (const p of props) {
  try {
    await waitFor(() => evs(p.id, 'sim_result').length >= n, 10_000, `#${p.id} sim_result x${n}`)
    const bad = evs(p.id, 'sim_result').filter((r) => r.rule !== p.rule)
    if (bad.length) throw new Error(`${p.name}: ${bad.map((b) => `${b.source}=${b.verdict}/${b.rule}`).join(' ')}, expected ${p.rule}`)
    if (p.key && evs(p.id, 'sim_result').some((r) => r.extra?.approvalKey !== p.key)) throw new Error(`${p.name}: approvalKey ${evs(p.id, 'sim_result')[0].extra?.approvalKey} != ${p.key}`)
    await waitFor(() => evs(p.id, 'veto_receipt').length >= n, 10_000, `#${p.id} veto_receipt x${n}`)
    const pr = await pub.readContract({ address: dep.guardedAdmin, abi: gaAbi, functionName: 'getProposal', args: [BigInt(p.id)] })
    const first = Math.min(...evs(p.id, 'veto_receipt').map((r) => r.block))
    if (Number(pr.status) !== 2 || Number(pr.vetoCount) !== n) throw new Error(`${p.name}: status ${pr.status} vetoCount ${pr.vetoCount}`)
    if (first >= Number(pr.readyBlock)) throw new Error(`${p.name}: veto at ${first} >= readyBlock ${pr.readyBlock}`)
    const sentAfterAccept = evs(p.id, 'veto_sent').every((s) => s.extra?.acceptedBy)
    if (!sentAfterAccept) throw new Error(`${p.name}: veto_sent without acceptedBy`)
    console.log(`#${p.id} ${p.name.padEnd(22)} veto ${p.rule} x${n}, ${Number(pr.readyBlock) - first} blocks left`)
  } catch (e) {
    failures++
    console.error(`FAIL ${e.message}`)
  }
}

// /attach gate (first port runs ATTACH=1)
const url = `http://127.0.0.1:${PORTS[0]}/attach`
const body = JSON.stringify({ id: props[0].id, reportHash: keccak256(toHex('report')) })
const plain = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain', origin: 'https://evil.example' }, body })
const pre = await fetch(url, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } })
const unknown = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 999_999, reportHash: keccak256(toHex('x')) }) })
const good = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(process.env.ATTACH_SECRET ? { 'x-attach-secret': process.env.ATTACH_SECRET } : {}) }, body })
const checks = [
  ['text/plain refused (415)', plain.status === 415],
  ['no ACAO on /attach', plain.headers.get('access-control-allow-origin') == null && pre.headers.get('access-control-allow-origin') == null],
  ['unknown id refused', unknown.status === 400 && /unknown proposal/.test((await unknown.json()).error)],
  ['json + existing id accepted', good.status === 200],
]
for (const [what, ok] of checks) {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} /attach: ${what}`)
}
console.log(`\n${props.length} bypass proposals + ${checks.length} attach checks: ${failures} failures`)
process.exit(failures ? 1 : 0)
