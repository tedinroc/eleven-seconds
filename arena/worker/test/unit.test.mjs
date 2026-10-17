// Unit checks that need no chain: RPC failover, broadcast classification, report hashing, and the
// build-time guard that keeps the Arena off the live demo's contracts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { keccak256, stringToBytes } from 'viem'
import { RpcError, createFailover } from '../src/rpc.mjs'
import { broadcastAll } from '../src/signer.mjs'
import { makeReport } from '../src/report.mjs'

const WORKER = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fake = (label, impl) => ({ label, call: async (m, p) => impl(m, p) })

test('failover moves past a rate-limited provider and keeps reverts', async () => {
  const a = fake('a', () => {
    throw new RpcError('a: HTTP 429', { httpStatus: 429 })
  })
  const b = fake('b', () => '0x10')
  const f = createFailover([a, b])
  assert.equal(await f.call('eth_blockNumber'), '0x10')
  const r = fake('r', () => {
    throw new RpcError('r: execution reverted', { code: 3, data: '0x' })
  })
  await assert.rejects(createFailover([r, b]).call('eth_call'), /execution reverted/)
})

test('broadcast: any acceptance or "already known" delivers; nonce errors are flagged', async () => {
  const ok = fake('ok', () => '0xabc')
  const known = fake('known', () => {
    throw new RpcError('known: already known')
  })
  const low = fake('low', () => {
    throw new RpcError('low: nonce too low')
  })
  assert.equal((await broadcastAll([low, ok], '0x')).delivered, true)
  assert.equal((await broadcastAll([known], '0x')).delivered, true)
  const out = await broadcastAll([low], '0x')
  assert.equal(out.delivered, false)
  assert.equal(out.nonceError, true)
})

test('report is the reporter template and its hash is keccak256(utf8(text))', () => {
  const sim = { id: 7, verdict: 'veto', rule: 'R1_TOTAL_SUPPLY', checks: [{ name: 'R1_TOTAL_SUPPLY', before: '100', after: '200', ok: false }], selectorsAdded: [], simMs: 900, extra: {} }
  const r = makeReport(sim, { id: 7, kind: 0, target: '0x' + '11'.repeat(20), codehash: '0x' + '22'.repeat(32), proposeBlock: 10, readyBlock: 40 })
  assert.ok(r.text.includes('#7'))
  assert.equal(r.hash, keccak256(stringToBytes(r.text)))
  assert.equal(r.rule, 'R1_TOTAL_SUPPLY')
})

test('bundle-config refuses the live demo deployment', () => {
  const res = spawnSync(process.execPath, ['scripts/bundle-config.mjs'], { cwd: WORKER, env: { ...process.env, ARENA_DEPLOYMENT: '../../shared/deployments/10143.json' }, encoding: 'utf8' })
  assert.equal(res.status, 1)
  assert.match(res.stderr, /live demo/)
})
