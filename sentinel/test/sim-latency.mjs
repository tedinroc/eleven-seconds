#!/usr/bin/env node
// Read-only latency probe for eth_simulateV1 on the simulation RPCs (no transactions, no keys).
// Sends N small merged requests (stateDiff override + explicit gas, no `validation` field) over one
// kept-alive connection per provider and prints per-request latency and errors (e.g. HTTP 429).
//   N=6 node test/sim-latency.mjs [url ...]
import { createRpc } from '../src/rpc.mjs'
import { IMPLEMENTATION_SLOT } from '../src/simulate.mjs'
const urls = process.argv.slice(2).length ? process.argv.slice(2) : ['https://testnet-rpc.monad.xyz', 'https://10143.rpc.thirdweb.com']
const N = Number(process.env.N ?? 6)
const target = '0x' + '11'.repeat(20)
const params = [{
  blockStateCalls: [{
    stateOverrides: { [target]: { code: '0x60016000526020600060f3', stateDiff: { [IMPLEMENTATION_SLOT]: '0x' + '00'.repeat(31) + '01' } } },
    calls: Array.from({ length: 20 }, () => ({ from: '0x' + '22'.repeat(20), to: target, data: '0x', gas: '0x30d40' })),
  }],
}, 'latest']
for (const url of urls) {
  const rpc = createRpc(url, { timeoutMs: 5_000 })
  const t0 = Date.now()
  await rpc.call('eth_chainId').catch((e) => console.log(`${rpc.label} warmup error: ${e.message}`))
  const warm = Date.now() - t0
  const lat = []
  for (let i = 0; i < N; i++) {
    const t = Date.now()
    try {
      const r = await rpc.call('eth_simulateV1', params)
      lat.push(Date.now() - t)
      if (i === 0) console.log(`${rpc.label}: ${r[0].calls.length} calls, status ${r[0].calls[0].status}`)
    } catch (e) {
      lat.push(`ERR(${e.httpStatus ?? e.code}) ${Date.now() - t}`)
    }
  }
  console.log(`${rpc.label}: connect+chainId ${warm} ms; simulateV1 x${N} (kept alive): ${lat.join(', ')} ms`)
  rpc.close()
}
