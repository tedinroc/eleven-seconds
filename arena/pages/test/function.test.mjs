// Pages Function 单元测试（不连网、不需要 wrangler）：npm test
// .ts 档用 Node 内建的型别剥除载入（Node ≥ 22.18）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { onRequest } from '../functions/api/[[path]].ts'

test('原样转发到 ARENA service binding（method、网址、标头、body）', async () => {
  let got
  const env = { ARENA: { fetch: async (r) => ((got = r), new Response('{"ok":true}', { status: 200 })) } }
  const req = new Request('https://eleven-seconds-arena.pages.dev/api/attack?x=1', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' },
    body: JSON.stringify({ card: 'evilMint' }),
  })
  const res = await onRequest({ request: req, env })
  assert.equal(res.status, 200)
  assert.equal(got, req)
  assert.equal(got.method, 'POST')
  assert.equal(new URL(got.url).pathname, '/api/attack')
  assert.equal(got.headers.get('cf-connecting-ip'), '203.0.113.7')
  assert.deepEqual(await got.json(), { card: 'evilMint' })
})

test('429 与 Retry-After 原样回传', async () => {
  const env = { ARENA: { fetch: async () => new Response('{"ok":false,"retryAfterSec":30}', { status: 429, headers: { 'retry-after': '30' } }) } }
  const res = await onRequest({ request: new Request('https://x/api/attack', { method: 'POST' }), env })
  assert.equal(res.status, 429)
  assert.equal(res.headers.get('retry-after'), '30')
})

test('也接受 ARENA_ENGINE 名称', async () => {
  const env = { ARENA_ENGINE: { fetch: async () => new Response('state') } }
  const res = await onRequest({ request: new Request('https://x/api/state'), env })
  assert.equal(await res.text(), 'state')
})

test('没有设定 binding → 503 JSON', async () => {
  const res = await onRequest({ request: new Request('https://x/api/state'), env: {} })
  assert.equal(res.status, 503)
  assert.equal((await res.json()).error, 'ARENA binding not configured')
})
