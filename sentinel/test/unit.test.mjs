// Offline unit checks: selector extraction vs compiled artifacts, rule hashes vs shared/rules.json,
// ERC-1967 slot vs the OpenZeppelin constant, gas.json parsing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { REPO_ROOT } from '../src/config.mjs'
import { extractSelectors } from '../src/bytecode.mjs'
import { loadRules, computeRuleHash, RULE_IDS } from '../src/rules.mjs'
import { IMPLEMENTATION_SLOT } from '../src/simulate.mjs'
import { readGasLimits } from '../src/vetoer.mjs'

const art = (n) => resolve(REPO_ROOT, `out/${n}.sol/${n}.json`)

test('selector scan matches solc methodIdentifiers', { skip: !existsSync(art('EvilOwnerImpl')) && 'run forge build first' }, () => {
  for (const n of ['DemoBTC', 'DemoBTCV2', 'EvilMintImpl', 'EvilOwnerImpl', 'EvilFeeImpl', 'PausedImpl']) {
    const j = JSON.parse(readFileSync(art(n), 'utf8'))
    const want = Object.values(j.methodIdentifiers).map((s) => '0x' + s).sort()
    assert.deepEqual(extractSelectors(j.deployedBytecode.object), want, n)
  }
})

test('rule hashes agree with shared/rules.json', () => {
  const table = loadRules(resolve(REPO_ROOT, 'shared/rules.json'), {})
  for (const id of RULE_IDS) assert.equal(table[id].hash, computeRuleHash(id))
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
