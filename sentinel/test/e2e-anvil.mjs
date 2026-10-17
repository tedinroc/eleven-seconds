#!/usr/bin/env node
// End-to-end check on a local anvil with three running sentinels (anvil only: uses anvil's public
// test accounts). Each round proposes the four cards at once (evilMint, evilOwner, evilFee, v2) and
// checks: every sentinel gives the expected verdict exactly once, malicious proposals end Vetoed with
// vetoCount == live sentinels before readyBlock, execute of a vetoed proposal reverts ProposalVetoed,
// v2 executes after the delay and version() == "2".
//
//   (defaults: RPC 8545, shared/deployments/anvil.json, SSE 8701-8703) ROUNDS=5 node test/e2e-anvil.mjs
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPublicClient, createWalletClient, http, decodeErrorResult, encodeFunctionData, BaseError, ContractFunctionRevertedError } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { REPO_ROOT } from '../src/config.mjs'
import { sleep } from '../src/util.mjs'

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8545'
const dep = JSON.parse(readFileSync(resolve(REPO_ROOT, process.env.DEPLOYMENTS ?? 'shared/deployments/anvil.json'), 'utf8'))
const PORTS = (process.env.SSE_PORTS ?? '8701,8702,8703').split(',').map(Number)
const ROUNDS = Number(process.env.ROUNDS ?? 5)
const gaAbi = JSON.parse(readFileSync(resolve(REPO_ROOT, 'shared/abi/GuardedAdmin.json'), 'utf8'))
const tokenAbi = JSON.parse(readFileSync(resolve(REPO_ROOT, 'shared/abi/DemoBTC.json'), 'utf8'))
const gas = JSON.parse(readFileSync(resolve(REPO_ROOT, 'shared/gas.json'), 'utf8'))

const MN = 'test test test test test test test test test test test junk'
const admin = mnemonicToAccount(MN, { addressIndex: 1 })
const chain = { ...foundry, id: dep.chainId }
const pub = createPublicClient({ chain, transport: http(RPC_URL), pollingInterval: 100 })
const wallet = createWalletClient({ chain, transport: http(RPC_URL), account: admin })
if ((await pub.getChainId()) !== 31337) throw new Error('e2e runs on anvil only')

// ---- collect SSE from every sentinel
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

const EXPECT = { evilMint: 'R1_TOTAL_SUPPLY', evilOwner: 'R2_OWNER', evilFee: 'R3_TRANSFER_CONSERVATION', v2: null }
const evs = (id, type) => events.filter((e) => e.id === id && e.type === type)
const waitFor = async (pred, ms, what) => {
  const t = Date.now()
  while (Date.now() - t < ms) {
    if (pred()) return
    await sleep(50)
  }
  throw new Error(`timeout waiting for ${what}`)
}
const revertName = async (fn, args) => {
  try {
    await pub.call({ to: dep.guardedAdmin, data: encodeFunctionData({ abi: gaAbi, functionName: fn, args }), account: admin.address })
    return null
  } catch (e) {
    const r = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError || x?.data) : null
    const data = r?.data?.data ?? r?.data ?? e?.cause?.data
    try {
      return decodeErrorResult({ abi: gaAbi, data: typeof data === 'string' ? data : data?.data }).errorName
    } catch {
      return e.shortMessage ?? 'reverted'
    }
  }
}

let falseVerdicts = 0
let failures = 0
const nSentinels = () => [...live.values()].filter(Boolean).length
for (let round = 1; round <= ROUNDS; round++) {
  const cards = Object.keys(EXPECT).sort(() => Math.random() - 0.5)
  const ids = {}
  for (const card of cards) {
    const nextId = Number(await pub.readContract({ address: dep.guardedAdmin, abi: gaAbi, functionName: 'nextId' }))
    const hash = await wallet.writeContract({ address: dep.guardedAdmin, abi: gaAbi, functionName: 'proposeUpgrade', args: [dep.impls[card], '0x'], gas: BigInt(gas.propose.gasLimit) })
    const rc = await pub.waitForTransactionReceipt({ hash })
    ids[card] = { id: nextId, block: Number(rc.blockNumber) }
  }
  const n = nSentinels()
  for (const card of cards) {
    const { id } = ids[card]
    try {
      await waitFor(() => evs(id, 'sim_result').length >= n, 8_000, `#${id} sim_result x${n}`)
      const results = evs(id, 'sim_result')
      const seen = evs(id, 'proposal_seen')
      const bySource = new Map()
      for (const s of seen) bySource.set(s.source, (bySource.get(s.source) ?? 0) + 1)
      if ([...bySource.values()].some((c) => c !== 1)) throw new Error(`#${id} proposal_seen not deduped: ${JSON.stringify([...bySource])}`)
      for (const r of results) {
        if ((r.rule ?? null) !== EXPECT[card]) {
          falseVerdicts++
          throw new Error(`#${id} ${card}: ${r.source} said ${r.verdict}/${r.rule}, expected ${EXPECT[card] ?? 'pass'}`)
        }
      }
      if (EXPECT[card]) {
        await waitFor(() => evs(id, 'veto_receipt').length >= n, 8_000, `#${id} veto_receipt x${n}`)
        const bad = evs(id, 'veto_receipt').filter((r) => r.status !== 'success')
        if (bad.length) throw new Error(`#${id} veto tx reverted for ${bad.map((b) => b.source).join(',')} (gasUsed ${bad.map((b) => b.gasUsed + '/' + b.gasLimit).join(' ')})`)
        const sent = evs(id, 'veto_sent')
        if (new Set(sent.map((s) => s.source)).size !== sent.length) throw new Error(`#${id} a sentinel vetoed twice`)
        const p = await pub.readContract({ address: dep.guardedAdmin, abi: gaAbi, functionName: 'getProposal', args: [BigInt(id)] })
        const blocks = evs(id, 'veto_receipt').map((r) => r.block)
        const first = Math.min(...blocks)
        if (Number(p.status) !== 2 || Number(p.vetoCount) !== n) throw new Error(`#${id} status ${p.status} vetoCount ${p.vetoCount}`)
        if (first >= Number(p.readyBlock)) throw new Error(`#${id} veto landed at ${first} >= readyBlock ${p.readyBlock}`)
        const lat = evs(id, 'veto_receipt').map((r) => r.latencyMs)
        console.log(`round ${round} #${id} ${card.padEnd(9)} veto ${EXPECT[card]} x${n}  first veto +${first - ids[card].block} blocks, ${Number(p.readyBlock) - first} blocks left; latency ms ${lat.join('/')}`)
      } else {
        console.log(`round ${round} #${id} ${card.padEnd(9)} pass x${n}`)
      }
    } catch (e) {
      failures++
      console.error(`FAIL ${e.message}`)
    }
  }
  // Optional: kill one sentinel (KILL_PORT) after a round; the others must keep vetoing.
  if (process.env.KILL_PORT && round === Number(process.env.KILL_AFTER_ROUND ?? 2)) {
    const { execSync } = await import('node:child_process')
    const pid = execSync(`lsof -ti tcp:${process.env.KILL_PORT} -sTCP:LISTEN`).toString().trim()
    const lastHb = () => Math.max(0, ...events.filter((e) => e.port === Number(process.env.KILL_PORT) && e.type === 'heartbeat').map((e) => e.ts))
    process.kill(Number(pid), 'SIGKILL')
    const killedAt = Date.now()
    await sleep(2_000)
    console.log(`killed sentinel on :${process.env.KILL_PORT} (pid ${pid}); last heartbeat ${killedAt - lastHb()} ms before kill, none since: ${lastHb() < killedAt}`)
  }
  // Wait out the delay, then execute: vetoed ones must revert ProposalVetoed, v2 must succeed.
  const ready = Math.max(...Object.values(ids).map((x) => x.block)) + Number(dep.delayBlocks ?? 30)
  while (Number(await pub.getBlockNumber()) < ready) await sleep(100)
  for (const card of cards) {
    const { id } = ids[card]
    const err = await revertName('execute', [BigInt(id)])
    if (EXPECT[card]) {
      if (err !== 'ProposalVetoed') {
        failures++
        console.error(`FAIL #${id} execute expected ProposalVetoed, got ${err}`)
      }
    } else {
      if (err) {
        failures++
        console.error(`FAIL #${id} v2 execute reverts: ${err}`)
        continue
      }
      const h = await wallet.writeContract({ address: dep.guardedAdmin, abi: gaAbi, functionName: 'execute', args: [BigInt(id)], gas: BigInt(gas.execute.gasLimit) })
      await pub.waitForTransactionReceipt({ hash: h })
      const v = await pub.readContract({ address: dep.proxy, abi: tokenAbi, functionName: 'version' })
      if (v !== '2') {
        failures++
        console.error(`FAIL version() = ${v}`)
      } else console.log(`round ${round} #${id} v2 executed at/after block ${ready}, version()="2", execute of vetoed -> ProposalVetoed`)
    }
  }
}
const health0 = null
const health = await Promise.all(PORTS.map((p) => fetch(`http://127.0.0.1:${p}/health`).then((r) => r.json()).catch(() => null)))
console.log('dedupe (duplicates dropped per sentinel):', health.map((h) => h?.duplicatesDropped ?? 'offline').join(' / '))
console.log(`\n${ROUNDS} rounds: ${failures} failures, ${falseVerdicts} wrong verdicts`)
process.exit(failures ? 1 : 0)
