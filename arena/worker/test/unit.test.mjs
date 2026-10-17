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
import { fundsCheck, monToWei } from '../src/funds.mjs'

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

const SIM7 = { id: 7, verdict: 'veto', rule: 'R1_TOTAL_SUPPLY', checks: [{ name: 'R1_TOTAL_SUPPLY', before: '100', after: '200', ok: false }], selectorsAdded: [], simMs: 900, extra: {} }
const PROP7 = { id: 7, kind: 0, target: '0x' + '11'.repeat(20), codehash: '0x' + '22'.repeat(32), proposeBlock: 10, readyBlock: 40 }

test('without Workers AI the report is the reporter template and its hash is keccak256(utf8(text))', async () => {
  const r = await makeReport(SIM7, PROP7)
  assert.ok(r.text.includes('#7'))
  assert.equal(r.template, true)
  assert.equal(r.hash, keccak256(stringToBytes(r.text)))
  assert.equal(r.rule, 'R1_TOTAL_SUPPLY')
})

test('Workers AI wording is used when it passes the reporter guard', async () => {
  const ai = { run: async (model, input) => ({ response: '<think>\n\n</think>\n提案 #7 被否决：总供应量被改变，存在无限增发风险。建议多签维持否决并更换密钥。' }) }
  const r = await makeReport(SIM7, PROP7, { ai })
  assert.equal(r.template, false)
  assert.equal(r.model, '@cf/qwen/qwen3-30b-a3b-fp8')
  assert.ok(r.text.startsWith('提案 #7') && !r.text.includes('think'))
  assert.equal(r.hash, keccak256(stringToBytes(r.text)))
})

test('Workers AI output with an invented number, an error or a timeout falls back to the template', async () => {
  const invented = { run: async () => ({ response: '提案 #7 被否决，损失约 999 万美元。建议多签维持否决。' }) }
  const broken = { run: async () => { throw new Error('upstream 503') } }
  const slow = { run: () => new Promise(() => {}) }
  for (const [ai, why] of [[invented, /unsupported_number/], [broken, /503/], [slow, /timeout/]]) {
    const r = await makeReport(SIM7, PROP7, { ai, timeoutMs: 50 })
    assert.equal(r.template, true)
    assert.match(r.fallbackReason, why)
    assert.ok(r.text.includes('#7'))
  }
})

test('bundle-config refuses the live demo deployment', () => {
  const res = spawnSync(process.execPath, ['scripts/bundle-config.mjs'], { cwd: WORKER, env: { ...process.env, ARENA_DEPLOYMENT: '../../shared/deployments/10143.json' }, encoding: 'utf8' })
  assert.equal(res.status, 1)
  assert.match(res.stderr, /live demo/)
})

test('fuel gate refuses new cards when any wallet is below its floor, and never blocks on unknown balances', () => {
  const cfg = { minAdminWei: monToWei(0.1), minSentinelWei: monToWei(0.06) }
  const bal = (admin, ...s) => ({ at: 0, admin: { wei: monToWei(admin).toString(), mon: String(admin) }, sentinels: s.map((m, i) => ({ index: i + 1, wei: monToWei(m).toString(), mon: String(m) })) })
  assert.equal(monToWei(0.0135), 13_500_000_000_000_000n)
  assert.deepEqual(fundsCheck(bal(5.6, 2.7, 2.8, 2.8), cfg), { ok: true, low: [] })
  const low = fundsCheck(bal(5.6, 0.05, 2.8, 2.8), cfg)
  assert.equal(low.ok, false)
  assert.deepEqual(low.low.map((x) => x.who), ['sentinel1'])
  assert.deepEqual(fundsCheck(bal(0.09, 1, 1, 1), cfg).low.map((x) => x.who), ['admin'])
  assert.equal(fundsCheck(null, cfg).ok, true)
})
