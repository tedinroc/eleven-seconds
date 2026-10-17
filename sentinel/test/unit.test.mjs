// Offline unit checks: selector extraction vs compiled artifacts, rule hashes vs shared/rules.json,
// ERC-1967 slot vs the OpenZeppelin constant, gas.json parsing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { REPO_ROOT } from '../src/config.mjs'
import { extractSelectors, dangerousOpcodes } from '../src/bytecode.mjs'
import { loadRules, computeRuleHash, RULE_IDS } from '../src/rules.mjs'
import { IMPLEMENTATION_SLOT, buildSimulation, evaluateSimulation, probeCalldata, PROBES_PER_SELECTOR } from '../src/simulate.mjs'
import { loadAbis } from '../src/abi.mjs'
import { actionHash, upgradeDataKey, approvalKeyFor } from '../src/keys.mjs'
import { Vetoer } from '../src/vetoer.mjs'
import { createEventServer, checkAttachRequest } from '../src/sse.mjs'
import { readGasLimits } from '../src/vetoer.mjs'

const art = (n) => resolve(REPO_ROOT, `out/${n}.sol/${n}.json`)
// Locally these tests skip without `forge build`; in CI a missing build is an error, not a silent skip.
if (process.env.CI && !existsSync(art('EvilOwnerImpl'))) throw new Error('CI: run `forge build` at the repo root before the sentinel tests')

// Every solc selector must be found; at most one short-push extra (0x0000001f: a string-length
// compare with the dispatcher's shape) is tolerated, since an extra selector is only one more probe.
const DEMO = ['DemoBTC', 'DemoBTCV2', 'EvilMintImpl', 'EvilOwnerImpl', 'EvilFeeImpl', 'PausedImpl']
const assertSelectors = (j, n) => {
  const want = Object.values(j.methodIdentifiers).map((s) => '0x' + s).sort()
  const got = extractSelectors(j.deployedBytecode.object)
  assert.deepEqual(want.filter((s) => !got.includes(s)), [], `${n}: missing selectors`)
  const extra = got.filter((s) => !want.includes(s))
  assert.ok(extra.length <= 1 && extra.every((s) => BigInt(s) < 0x100n), `${n}: unexpected extra ${extra}`)
}
test('selector scan finds every solc methodIdentifier', { skip: !existsSync(art('EvilOwnerImpl')) && 'run forge build first' }, () => {
  for (const n of DEMO) assertSelectors(JSON.parse(readFileSync(art(n), 'utf8')), n)
})

test('selector scan: PUSH1-PUSH3 dispatcher entries are left-padded to 4 bytes', () => {
  // DUP1 PUSH3 00dca85e EQ PUSH2 0100 JUMPI | DUP1 PUSH4 a9059cbb EQ PUSH2 0200 JUMPI | DUP1 PUSH2 0017 EQ PUSH1 33 JUMPI
  const code = '0x' + '80' + '62dca85e' + '14' + '610100' + '57' + '80' + '63a9059cbb' + '14' + '610200' + '57' + '80' + '610017' + '14' + '6033' + '57' + '00'
  assert.deepEqual(extractSelectors(code), ['0x00000017', '0x00dca85e', '0xa9059cbb'])
  // ordinary arithmetic with a short push is not a selector: PUSH1 20 DUP2 LT ... (no DUP before, no JUMPI)
  assert.deepEqual(extractSelectors('0x' + '6020' + '81' + '10' + '01' + '00'), [])
})

test('R9 opcode scan: demo impls have none of the dangerous opcodes; PUSH data and metadata are skipped', { skip: !existsSync(art('EvilOwnerImpl')) && 'run forge build first' }, () => {
  for (const n of DEMO) {
    const j = JSON.parse(readFileSync(art(n), 'utf8'))
    assert.deepEqual(dangerousOpcodes(j.deployedBytecode.object), [], n)
  }
  // PUSH2 f1f4 (data, not CALL/DELEGATECALL) then NUMBER then STOP, then CBOR tail a2 .. ff 00 05
  assert.deepEqual(dangerousOpcodes('0x' + '61f1f4' + '43' + '00' + 'a2ff42f100' + '0005'), ['NUMBER'])
  assert.deepEqual(dangerousOpcodes('0x' + '5af1fa3242'), ['CALL', 'GAS', 'ORIGIN', 'STATICCALL', 'TIMESTAMP'])
})

// Extended attack fixtures (test/fixtures/*.sol), when their compiled out dir is given: ATTACKS_OUT=<forge out>
const BYP = process.env.ATTACKS_OUT
test('extended fixtures: zero-byte selectors found, time/flag/origin bombs flagged by R9', { skip: !(BYP && existsSync(resolve(BYP, 'Attacks.sol'))) && 'set ATTACKS_OUT' }, () => {
  const fx = (f, n) => JSON.parse(readFileSync(resolve(BYP, f, `${n}.json`), 'utf8'))
  for (const n of ['EvilTransferFromImpl', 'ThreeArgMintImpl', 'V2Init', 'V2Init3', 'TimeBombMintImpl', 'FlagMintImpl', 'OriginMintImpl']) assertSelectors(fx('Attacks.sol', n), n)
  if (existsSync(resolve(BYP, 'Evil.sol'))) for (const n of ['EvilZeroSelMint', 'EvilZeroSelOwner', 'Evil3ArgMint', 'EvilSweep']) assertSelectors(fx('Evil.sol', n), n)
  assert.deepEqual(dangerousOpcodes(fx('Attacks.sol', 'TimeBombMintImpl').deployedBytecode.object), ['NUMBER'])
  assert.deepEqual(dangerousOpcodes(fx('Attacks.sol', 'OriginMintImpl').deployedBytecode.object), ['ORIGIN'])
  assert.ok(dangerousOpcodes(fx('Attacks.sol', 'FlagMintImpl').deployedBytecode.object).includes('STATICCALL'))
  for (const n of ['EvilTransferFromImpl', 'ThreeArgMintImpl', 'V2Init']) assert.deepEqual(dangerousOpcodes(fx('Attacks.sol', n).deployedBytecode.object), [], n)
})

test('rule hashes agree with shared/rules.json (every rule present, with a zh label)', () => {
  const table = loadRules(resolve(REPO_ROOT, 'shared/rules.json'), {})
  for (const id of RULE_IDS) assert.equal(table[id].hash, computeRuleHash(id))
  const file = JSON.parse(readFileSync(resolve(REPO_ROOT, 'shared/rules.json'), 'utf8')).rules
  for (const id of RULE_IDS) {
    const r = file.find((x) => x.rule === id)
    assert.ok(r, `${id} in rules.json`)
    assert.equal(r.ruleHash, computeRuleHash(id))
    assert.ok(r.zh, `${id} zh label`)
  }
  assert.ok(RULE_IDS.includes('R3B_THIRD_PARTY_FUNDS') && RULE_IDS.includes('R9_NEW_OPCODES'))
})

test('implementation slot equals OZ ERC1967Utils.IMPLEMENTATION_SLOT', () => {
  const src = readFileSync(resolve(REPO_ROOT, 'lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Utils.sol'), 'utf8')
  const m = src.match(/IMPLEMENTATION_SLOT\s*=\s*(0x[0-9a-fA-F]{64})/)
  assert.ok(m)
  assert.equal(IMPLEMENTATION_SLOT, m[1].toLowerCase())
})

test('gas.json parsing applies headroom and falls back', () => {
  const g = readGasLimits({ veto: { gasUsed: 100, gasLimit: 110 }, attachReason: 50 }, {}, 1.25)
  assert.equal(g.veto, 138n)
  assert.equal(g.attachReason, 63n)
  assert.equal(readGasLimits(null, {}, 1).veto, 200000n)
})

// ---- RPC transport: keep-alive reuse, immediate failover, race, classification (local servers only)
import http from 'node:http'
import net from 'node:net'
import { createRpc, createFailover, raceRpc, RpcError, isRetryable } from '../src/rpc.mjs'

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)))
const okServer = (result = '0x1', delayMs = 0) => http.createServer((req, res) => {
  let b = ''
  req.on('data', (c) => (b += c))
  req.on('end', () => setTimeout(() => res.end(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(b).id, result })), delayMs))
})
const resetServer = () => net.createServer((s) => s.destroy()) // like "tls handshake eof" / ECONNRESET
const statusServer = (code) => http.createServer((req, res) => { req.resume(); res.statusCode = code; res.end('busy') })

test('keep-alive: one socket reused across sequential calls', async () => {
  const srv = okServer()
  const rpc = createRpc(await listen(srv))
  for (let i = 0; i < 5; i++) assert.equal(await rpc.call('eth_chainId'), '0x1')
  assert.equal(rpc.stats.fresh, 1)
  assert.equal(rpc.stats.reused, 4)
  rpc.close()
  srv.close()
})

test('failover: reset / 429 / 503 move to the next RPC at once and stick; JSON-RPC errors do not', async () => {
  const servers = [resetServer(), statusServer(429), statusServer(503), okServer('0xgood')]
  const urls = await Promise.all(servers.map(listen))
  const clients = urls.map((u) => createRpc(u, { timeoutMs: 1_000 }))
  const fo = createFailover(clients, { name: 'test' })
  const t = Date.now()
  assert.equal(await fo.call('eth_blockNumber'), '0xgood')
  assert.ok(Date.now() - t < 900, 'no timeout wait on transport errors')
  assert.equal(fo.label, clients[3].label)
  assert.equal(fo.switches.length, 1)
  assert.equal(await fo.call('eth_blockNumber'), '0xgood') // sticky: goes straight to the good one
  assert.equal(clients[0].stats.requests, 1)
  assert.equal(isRetryable(new RpcError('execution reverted', { code: 3 })), false)
  assert.equal(isRetryable(new RpcError('tls handshake eof', { code: 'NETWORK' })), true)
  assert.equal(isRetryable(new RpcError('HTTP request failed.')), true)
  assert.equal(isRetryable(new RpcError('HTTP 429 too many', { httpStatus: 429 })), true)
  assert.equal(isRetryable(new RpcError('exceeds block gas limit', { code: -32000 })), false)
  clients.forEach((c) => c.close())
  servers.forEach((s) => s.close())
})

test('race: first good answer wins, a failing or slow provider does not delay it', async () => {
  const servers = [resetServer(), okServer('0xslow', 400), okServer('0xfast', 10)]
  const clients = (await Promise.all(servers.map(listen))).map((u) => createRpc(u))
  const t = Date.now()
  const r = await raceRpc(clients, 'eth_getCode', [])
  assert.equal(r.result, '0xfast')
  assert.ok(Date.now() - t < 300)
  clients.forEach((c) => c.close())
  servers.forEach((s) => s.close())
})

test('a latency-critical call waits for an in-flight keep-warm ping instead of opening a socket', async () => {
  const srv = okServer('0x1', 150)
  const rpc = createRpc(await listen(srv))
  await rpc.call('eth_chainId')
  rpc.ping(0)
  assert.equal(await rpc.call('eth_simulateV1', [], { waitPingMs: 600 }), '0x1')
  assert.equal(rpc.stats.fresh, 1, 'still one socket')
  rpc.close()
  srv.close()
})

// ---- simulation layout and evaluation (synthetic results, no chain)
import { encodeFunctionResult } from 'viem'
const quiet = { info() {}, warn() {}, error() {} }
const abis = loadAbis(resolve(REPO_ROOT, 'shared'), quiet)
const A = (k) => '0x' + String(k).repeat(40).slice(0, 40)
const SIM = { proxy: A(1), newImpl: A(2), holder: A(3), amount: 100n, watch: [A(4), A(3), A(5)], tokenAbi: abis.token, callGas: 300000n, readGas: 100000n }
const oneSelector = '0x' + '80' + '63a9059cbb' + '14' + '610200' + '57' + '00'

function fakeResult(layout, { transferFrom = 'revert', finalDelta = {} } = {}) {
  const bal0 = new Map(layout.watchList.map((a) => [a, a === layout.holder ? 1000n : 0n]))
  const after = new Map(bal0)
  after.set(layout.holder, 1000n - layout.amount)
  after.set(layout.receiver, layout.amount)
  const final = new Map(after)
  for (const [a, d] of Object.entries(finalDelta)) final.set(a, (final.get(a) ?? 0n) + d)
  const phase = (i) => (i < layout.transfer ? bal0 : i < layout.r2.totalSupply ? after : final)
  const enc = (fn, v) => encodeFunctionResult({ abi: abis.token, functionName: fn, result: v })
  const bIdx = (r) => r.balances
  const calls = layout.calls.map((c, i) => {
    if (c._tag === 'transfer') return { status: '0x1', returnData: enc('transfer', true), logs: [] }
    if (c._tag === 'transferFrom') return transferFrom === 'revert' ? { status: '0x0', returnData: '0x', logs: [] } : { status: '0x1', returnData: enc('transferFrom', transferFrom === 'true'), logs: [] }
    if (c._tag === 'probe') return { status: '0x0', returnData: '0x', logs: [] }
    if (c._fn === 'totalSupply') return { status: '0x1', returnData: enc('totalSupply', 1000n), logs: [] }
    if (c._fn === 'owner') return { status: '0x1', returnData: enc('owner', A(4)), logs: [] }
    for (const r of [layout.r0, layout.r1, layout.r2]) {
      const k = bIdx(r).indexOf(i)
      if (k >= 0) return { status: '0x1', returnData: enc('balanceOf', phase(i).get(layout.watchList[k])), logs: [] }
    }
    throw new Error(`unmapped call ${i} ${c._tag}`)
  })
  return [{ calls }]
}

test('probes: 5 shapes per selector incl. an 8-word wide set, plus empty and random fallback calldata', () => {
  const shapes = probeCalldata('0xa9059cbb', A(7))
  assert.equal(shapes.length, PROBES_PER_SELECTOR)
  const wide = shapes.find((p) => p.args === 'wide')
  assert.equal((wide.data.length - 10) / 64, 8)
  const { layout } = buildSimulation({ ...SIM, newCode: oneSelector })
  assert.deepEqual(layout.selectors, ['0xa9059cbb'])
  assert.equal(layout.probes.length, PROBES_PER_SELECTOR + 2)
  const fb = layout.probes.filter((p) => p.selector === 'fallback').map((p) => layout.calls[p.index].data)
  assert.equal(fb[0], '0x')
  assert.ok(fb[1].length > 10 && fb[1].slice(0, 10) !== '0xa9059cbb')
  assert.equal(layout.truncated, false)
  assert.ok(layout.r2.balances.length === layout.watchList.length, 'final reads include every watched balance')
})

test('probes that do not fit in SIM_MAX_CALLS mark the layout truncated (judge -> R6)', () => {
  let code = '0x'
  for (let k = 0; k < 40; k++) code += '80' + '63' + (0x10000000 + k).toString(16) + '14' + '610100' + '57'
  const { layout } = buildSimulation({ ...SIM, newCode: code + '00', maxCalls: 150 })
  assert.equal(layout.selectors.length, 40)
  assert.equal(layout.truncated, true)
  assert.ok(layout.calls.length <= 150)
})

test('R3B: stranger transferFrom without allowance, or any watched balance moved by stranger calls, is a veto', () => {
  const { layout } = buildSimulation({ ...SIM, newCode: oneSelector })
  const ev = (o) => evaluateSimulation(fakeResult(layout, o), layout, { tokenAbi: abis.token, oldSelectors: [] })
  const clean = ev({})
  assert.equal(clean.verdict, 'pass', clean.checks.filter((c) => !c.ok).map((c) => c.name).join())
  assert.equal(ev({ transferFrom: 'false' }).verdict, 'pass') // returns false without moving funds: fine
  const pulled = ev({ transferFrom: 'true' })
  assert.equal(pulled.rule, 'R3B_THIRD_PARTY_FUNDS')
  const swept = ev({ finalDelta: { [layout.holder]: -900n } })
  assert.equal(swept.rule, 'R3B_THIRD_PARTY_FUNDS')
  assert.equal(swept.extra.thirdPartyDeltas[0].address, layout.holder)
})

test('approval keys: R7 = keccak(abi.encode(kind,target,value)) for every config kind; R8 binds the data', () => {
  const t = A(9)
  const k1 = approvalKeyFor({ kind: 1, target: t, value: 1n })
  assert.equal(k1, actionHash(1, t, 1n))
  assert.notEqual(k1, actionHash(1, t, 0n), 'add and remove guardian need separate approvals')
  const k3 = approvalKeyFor({ kind: 3, target: t, value: 0n, codehash: '0x' + 'ab'.repeat(32) })
  assert.equal(k3, actionHash(3, t, 0n), 'SetPausedImpl does not reuse the upgrade codehash')
  const ch = '0x' + 'cd'.repeat(32)
  assert.notEqual(upgradeDataKey(ch, '0x1234'), upgradeDataKey(ch, '0x1235'))
  assert.notEqual(upgradeDataKey(ch, '0x1234'), ch)
})

// ---- vetoer liveness (mock RPCs; throwaway random key, never funded)
import { privateKeyToAccount } from 'viem/accounts'
import { loadRules as loadRuleTable } from '../src/rules.mjs'
const ruleTable = loadRuleTable(resolve(REPO_ROOT, 'shared/rules.json'), {})
const throwaway = () => privateKeyToAccount('0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'))
function mockMain({ latest = 5, pending = 5, receipt = () => null } = {}) {
  return {
    calls: [],
    async call(m, p) {
      this.calls.push([m, p])
      if (m === 'eth_getTransactionCount') return '0x' + (p[1] === 'pending' ? pending : latest).toString(16)
      if (m === 'eth_gasPrice') return '0x3b9aca00'
      if (m === 'eth_maxPriorityFeePerGas') return '0x1'
      if (m === 'eth_getBlockByNumber') return { baseFeePerGas: '0x1' }
      if (m === 'eth_getTransactionReceipt') return receipt(p[0])
      return null
    },
  }
}
const mkRpc = (label, fn) => ({ label, n: 0, async call(m, p) { this.n++; return fn(m, p) } })
const mkVetoer = (main, bcast, extra = {}) => new Vetoer({ account: throwaway(), chainId: 31337, guardedAdmin: A(8), abi: abis.guardedAdmin, gasLimits: { veto: 123000n, attachReason: 55000n }, mainRpc: main, broadcastRpcs: bcast, rules: ruleTable, log: quiet, receiptTimeoutMs: 400, ...extra })

test('vetoer: init uses the pending nonce; "replacement transaction underpriced" is not delivered and resyncs', async () => {
  const main = mockMain({ latest: 5, pending: 7 })
  const { RpcError: E } = await import('../src/rpc.mjs')
  const v = mkVetoer(main, [mkRpc('a', () => { throw new E('replacement transaction underpriced', { code: -32003 }) })])
  await v.init()
  v.stop()
  assert.equal(v.nonce, 7)
  let sent = false
  await assert.rejects(v.send('veto', [1n, ruleTable.R1_TOTAL_SUPPLY.hash], { onBroadcast: () => (sent = true) }))
  assert.equal(sent, false, 'veto_sent only after an RPC accepted')
  assert.ok(main.calls.filter(([m, p]) => m === 'eth_getTransactionCount' && p[1] === 'pending').length >= 2, 'resynced from pending')
})

test('vetoer: veto_sent fires after acceptance with acceptedBy; an unmined tx is re-sent at the same nonce with a higher fee', async () => {
  const raws = []
  const main = mockMain({ latest: 3, pending: 3 })
  const { RpcError: E } = await import('../src/rpc.mjs')
  const rpc = mkRpc('a', (m, p) => {
    if (m === 'eth_sendRawTransactionSync') throw new E('Method not found', { code: -32601 })
    raws.push(p[0])
    return '0x' + '11'.repeat(32)
  })
  const v = mkVetoer(main, [rpc], { replaceAfterMs: 100, receiptTimeoutMs: 700 })
  await v.init()
  v.stop()
  let info = null
  const tx = await v.send('veto', [2n, ruleTable.R1_TOTAL_SUPPLY.hash], { onBroadcast: (x) => (info = x) })
  assert.equal(info.acceptedBy, 'a')
  await assert.rejects(tx.receipt, /no receipt/)
  assert.ok(raws.length >= 2, 'replacement broadcast')
  const { parseTransaction } = await import('viem')
  const [t0, t1] = raws.map((r) => parseTransaction(r))
  assert.equal(t0.nonce, 3)
  assert.equal(t1.nonce, 3, 'same nonce')
  assert.ok(t1.maxFeePerGas > t0.maxFeePerGas && t1.maxPriorityFeePerGas > t0.maxPriorityFeePerGas, 'higher fee')
})

// ---- /attach gate
test('/attach: json only, no CORS, shared secret when set, loopback only otherwise', async () => {
  const req = (headers, remoteAddress = '127.0.0.1') => ({ headers, socket: { remoteAddress } })
  assert.equal(checkAttachRequest(req({ 'content-type': 'text/plain' }), null).code, 415)
  assert.equal(checkAttachRequest(req({ 'content-type': 'application/json' }), null), null)
  assert.equal(checkAttachRequest(req({ 'content-type': 'application/json' }, '10.0.0.2'), null).code, 403)
  assert.equal(checkAttachRequest(req({ 'content-type': 'application/json' }), 's3cret').code, 401)
  assert.equal(checkAttachRequest(req({ 'content-type': 'application/json; charset=utf-8', 'x-attach-secret': 's3cret' }), 's3cret'), null)
  let called = 0
  const s = createEventServer({ port: 0, source: 'x', mode: 'm', log: quiet, attachSecret: 'k', onAttach: async () => (called++, { ok: true }) })
  await s.listen()
  const port = s.address().port
  const url = `http://127.0.0.1:${port}/attach`
  const r1 = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain', origin: 'https://evil.example' }, body: '{"id":1}' })
  assert.equal(r1.status, 415)
  assert.equal(r1.headers.get('access-control-allow-origin'), null)
  const r2 = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":1}' })
  assert.equal(r2.status, 401)
  const r3 = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-attach-secret': 'k' }, body: '{"id":1}' })
  assert.equal(r3.status, 200)
  assert.equal(r3.headers.get('access-control-allow-origin'), null)
  const pre = await fetch(url, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } })
  assert.equal(pre.headers.get('access-control-allow-origin'), null)
  const ev = await fetch(`http://127.0.0.1:${port}/health`)
  assert.equal(ev.headers.get('access-control-allow-origin'), '*', 'read-only endpoints keep CORS for the frontend')
  assert.equal(called, 1)
  await s.close()
})
