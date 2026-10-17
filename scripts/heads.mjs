#!/usr/bin/env node
// Generic block-header probe: subscribes to new heads and prints block number,
// timestamp and wall-clock interval. A dev tool, not part of the app.
//
// Usage:
//   node scripts/heads.mjs                      # HTTP polling against the default RPC list
//   WS_URL=wss://... node scripts/heads.mjs     # eth_subscribe("newHeads") over WebSocket
//   RPC_URLS="https://a,https://b" node scripts/heads.mjs
//   COUNT=50 node scripts/heads.mjs             # stop after N blocks and print a summary
import { createPublicClient, defineChain, fallback, http, webSocket } from 'viem'

const RPC_URLS = (process.env.RPC_URLS ??
  'https://testnet-rpc.monad.xyz,https://rpc-testnet.monadinfra.com,https://rpc.ankr.com/monad_testnet,https://monad-testnet.drpc.org')
  .split(',').map((s) => s.trim()).filter(Boolean)
const WS_URL = process.env.WS_URL
const COUNT = Number(process.env.COUNT ?? 0)
const POLL_MS = Number(process.env.POLL_MS ?? 250)

const chain = defineChain({
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: RPC_URLS } },
  testnet: true,
})

const transport = WS_URL
  ? webSocket(WS_URL)
  : fallback(RPC_URLS.map((u) => http(u, { timeout: 4_000, retryCount: 1 })), { rank: false })

const client = createPublicClient({ chain, transport, pollingInterval: POLL_MS })

const chainId = await client.getChainId()
console.log(`chainId=${chainId} transport=${WS_URL ? 'ws ' + WS_URL : 'http ' + RPC_URLS[0] + (RPC_URLS.length > 1 ? ` (+${RPC_URLS.length - 1} fallback)` : '')}`)

let last = null
let seen = 0
const gaps = []
const unwatch = client.watchBlocks({
  emitOnBegin: true,
  emitMissed: true,
  poll: WS_URL ? false : true,
  onBlock: (b) => {
    const now = Date.now()
    const dt = last ? now - last.wall : 0
    const dts = last ? Number(b.timestamp - last.ts) : 0
    if (last) gaps.push(dt)
    console.log(`#${b.number} ts=${b.timestamp} txs=${b.transactions.length} wall+${dt}ms chain+${dts}s`)
    last = { wall: now, ts: b.timestamp }
    seen++
    if (COUNT && seen >= COUNT) {
      unwatch()
      const avg = gaps.length ? gaps.reduce((a, c) => a + c, 0) / gaps.length : 0
      console.log(`blocks=${seen} avg_wall_gap_ms=${avg.toFixed(0)}`)
      process.exit(0)
    }
  },
  onError: (e) => console.error(`error: ${e.shortMessage ?? e.message}`),
})

process.on('SIGINT', () => { unwatch(); process.exit(0) })
