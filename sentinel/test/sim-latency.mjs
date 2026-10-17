#!/usr/bin/env node
// Read-only latency probe (no transactions, no keys) for what a sentinel does on proposal_seen:
//   1. eth_getCode(newImpl) on the read RPCs: cold (new TLS connection) vs kept alive, and the race
//   2. eth_simulateV1 with the real merged request for the deployed EvilMint impl (same builder as
//      the sentinel, ~73 calls) on each simulation RPC: cold vs kept alive
//   3. socket reuse after idle gaps (does the server keep an idle connection for GAPS seconds?)
//   4. a request after a long idle while keepWarm pings every KEEPALIVE_MS (what the sentinel does)
//   5. the sentinel's critical path after that idle: race getCode on the read RPCs -> build -> simulate
// Providers are probed in parallel (different hosts). Defaults: Monad testnet + 10143.json.
//   N=6 GAPS=5,12,20,30 IDLE=25 KEEPALIVE_MS=12000 node test/sim-latency.mjs
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { encodeFunctionData, decodeFunctionResult } from 'viem'
import { createRpc, raceRpc, keepWarm } from '../src/rpc.mjs'
import { buildSimulation, evaluateSimulation } from '../src/simulate.mjs'
import { REPO_ROOT } from '../src/config.mjs'
import { csv, sleep } from '../src/util.mjs'

const SIM = csv(process.env.SIM_RPCS ?? 'https://testnet-rpc.monad.xyz,https://10143.rpc.thirdweb.com')
const READ = csv(process.env.READ_RPCS ?? 'https://rpc.ankr.com/monad_testnet,https://rpc-testnet.monadinfra.com')
const N = Number(process.env.N ?? 6)
const GAPS = csv(process.env.GAPS ?? '5,12,20,30').map(Number)
const IDLE = Number(process.env.IDLE ?? 25)
const KEEPALIVE_MS = Number(process.env.KEEPALIVE_MS ?? 12_000)
const CARD = process.env.CARD ?? 'evilMint'
const dep = JSON.parse(readFileSync(resolve(REPO_ROOT, process.env.DEPLOYMENTS ?? 'shared/deployments/10143.json'), 'utf8'))
const tokenAbi = JSON.parse(readFileSync(resolve(REPO_ROOT, 'shared/abi/DemoBTC.json'), 'utf8'))
const lc = (a) => a.toLowerCase()
const timed = async (fn) => {
  const t = Date.now()
  try {
    const r = await fn()
    return { ms: Date.now() - t, r }
  } catch (e) {
    return { ms: Date.now() - t, err: `${e.httpStatus ?? e.code ?? ''} ${e.message.slice(0, 60)}` }
  }
}
const fmt = (x, rpc) => (x.err ? `ERR(${x.err}) ${x.ms}` : `${x.ms}${rpc && rpc.stats.lastReused ? '' : '*'}`)

// ---- 1. read path: getCode cold / warm / race
const readers = READ.map((u) => createRpc(u, { timeoutMs: 5_000 }))
const impl = lc(dep.impls[CARD])
const readOut = await Promise.all(readers.map(async (rpc) => {
  const cold = await timed(() => rpc.call('eth_getCode', [impl, 'latest']))
  const coldFmt = fmt(cold, rpc)
  const warm = []
  for (let i = 0; i < N; i++) warm.push(fmt(await timed(() => rpc.call('eth_getCode', [impl, 'latest'])), rpc))
  return { rpc, cold, line: `${rpc.label.padEnd(26)} getCode cold ${coldFmt} ms; kept alive x${N}: ${warm.join(', ')} ms` }
}))
for (const o of readOut) console.log(o.line)
const races = []
for (let i = 0; i < N; i++) {
  const x = await timed(() => raceRpc(readers, 'eth_getCode', [impl, 'latest']))
  races.push(x.err ? `ERR ${x.ms}` : `${x.ms}(${x.r.label.split('.')[1] ?? x.r.label})`)
}
console.log(`${'race(read RPCs)'.padEnd(26)} getCode warm x${N}: ${races.join(', ')} ms`)

const code = readOut.find((o) => !o.cold.err)?.cold.r
if (!code || code === '0x') throw new Error(`no code for ${CARD} impl ${impl} on the read RPCs`)
const holder = lc(typeof dep.holders[0] === 'string' ? dep.holders[0] : dep.holders[0].address)
const balRet = await raceRpc(readers, 'eth_call', [{ to: dep.proxy, data: encodeFunctionData({ abi: tokenAbi, functionName: 'balanceOf', args: [holder] }) }, 'latest'])
const bal = decodeFunctionResult({ abi: tokenAbi, functionName: 'balanceOf', data: balRet.result })
const { params, layout } = buildSimulation({
  proxy: lc(dep.proxy), newImpl: impl, newCode: code, holder, amount: bal / 100n > 0n ? bal / 100n : 1n,
  watch: [lc(dep.owner), ...dep.holders.map((h) => lc(typeof h === 'string' ? h : h.address))], tokenAbi,
  callGas: 300_000n, readGas: 100_000n, maxCalls: 150,
})
console.log(`simulation request: ${layout.calls.length} calls, ${JSON.stringify(params).length} bytes (${CARD})`)

// ---- 2-4. simulation RPCs (the read RPCs are kept warm meanwhile, as in the sentinel)
const readWarm = keepWarm(readers, KEEPALIVE_MS)
const sims = SIM.map((url) => createRpc(url, { timeoutMs: 5_000 }))
const simOut = await Promise.all(sims.map(async (rpc) => {
  const lines = []
  const cold = await timed(() => rpc.call('eth_simulateV1', params))
  let verdict = ''
  if (!cold.err) {
    try {
      const v = evaluateSimulation(cold.r, layout, { tokenAbi, oldSelectors: [] })
      verdict = ` -> ${v.verdict}${v.rule ? ' ' + v.rule : ''}`
    } catch (e) {
      verdict = ` -> eval error ${e.message.slice(0, 60)}`
    }
  }
  lines.push(`simulateV1 cold (new connection) ${fmt(cold, rpc)} ms${verdict}`)
  const warm = []
  for (let i = 0; i < N; i++) warm.push(fmt(await timed(() => rpc.call('eth_simulateV1', params)), rpc))
  lines.push(`simulateV1 kept alive x${N}: ${warm.join(', ')} ms`)
  const gaps = []
  for (const g of GAPS) {
    await sleep(g * 1000)
    const x = await timed(() => rpc.call('eth_chainId'))
    gaps.push(`${g}s ${x.err ? 'ERR(' + x.err + ')' : (rpc.stats.lastReused ? 'reused' : 'NEW')} ${x.ms}`)
  }
  lines.push(`after idle gap -> eth_chainId: ${gaps.join(' | ')} ms`)
  const timer = keepWarm([rpc], KEEPALIVE_MS)
  await sleep(IDLE * 1000)
  const after = await timed(() => rpc.call('eth_simulateV1', params, { waitPingMs: 600 }))
  clearInterval(timer)
  lines.push(`simulateV1 after ${IDLE}s idle with keepWarm ${KEEPALIVE_MS / 1000}s: ${fmt(after, rpc)} ms (${rpc.stats.lastReused ? 'reused' : 'new'} socket); pings sent ${rpc.stats.requests - 2 - N - GAPS.length}`)
  lines.push(`sockets: ${rpc.stats.fresh} new, ${rpc.stats.reused} reused, ${rpc.stats.errors} errors`)
  return lines.map((l) => `${rpc.label.padEnd(26)} ${l}`)
}))
for (const l of simOut.flat()) console.log(l)

// ---- 5. critical path on warm sockets (what simMs measures in the sentinel, minus local CPU)
const sigs = Object.keys(dep.impls).filter((k) => k !== 'v1' && k !== 'paused')
for (const rpc of sims) {
  const totals = []
  for (let i = 0; i < Math.min(N, sigs.length * 2); i++) {
    const card = sigs[i % sigs.length]
    const t = Date.now()
    try {
      const { result: c, label } = await raceRpc(readers, 'eth_getCode', [lc(dep.impls[card]), 'latest'])
      const tc = Date.now() - t
      const b = buildSimulation({
        proxy: lc(dep.proxy), newImpl: lc(dep.impls[card]), newCode: c, holder, amount: bal / 100n > 0n ? bal / 100n : 1n,
        watch: [lc(dep.owner)], tokenAbi, callGas: 300_000n, readGas: 100_000n, maxCalls: 150,
      })
      const ts = Date.now()
      const r = await rpc.call('eth_simulateV1', b.params, { waitPingMs: 600 })
      const v = evaluateSimulation(r, b.layout, { tokenAbi, oldSelectors: [] })
      totals.push(`${card} ${Date.now() - t} (code ${tc} ${label.split('.')[1] ?? label}, sim ${Date.now() - ts}${rpc.stats.lastReused ? '' : '*'}, ${v.verdict})`)
    } catch (e) {
      totals.push(`${card} ERR ${e.message.slice(0, 60)} ${Date.now() - t}`)
    }
  }
  console.log(`${rpc.label.padEnd(26)} critical path getCode-race + simulateV1: ${totals.join('; ')} ms`)
}
clearInterval(readWarm)
for (const r of [...readers, ...sims]) r.close()
console.log(`(* = request opened a new connection)  ${new Date().toISOString()}`)
