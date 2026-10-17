#!/usr/bin/env node
// 战情室 driver（127.0.0.1:8700）：替画面送提案、冷静期满自动 execute、approver 预核准 codehash。
//
//   POST /propose  {"card":"evilMint"|"evilOwner"|"evilFee"|"v2"|"v1"}   admin 送 proposeUpgrade(impl, 0x)
//   POST /execute  {"id":"3"}      先 eth_call 拿错误名称，再用 gas.json 的固定 gas limit 真的送出
//   POST /approve  {"card":"v2"} 或 {"codehash":"0x…"}   approver 送 approveCodehash（严格模式用）
//   GET  /events   SSE（spec 4.4：heartbeat、execute_attempt）   GET /health   GET /deployments
//
// 环境变数：
//   DEPLOYMENT=anvil|10143      读 shared/deployments/<DEPLOYMENT>.json（预设 anvil）
//   RPC_URLS=a,b                读取／收据用（anvil 预设 http://127.0.0.1:8545；测试网预设 monadinfra、ankr）
//   BROADCAST_RPCS=a,b,c        广播用（测试网预设 官方、monadinfra、ankr 三路）
//   ADMIN_KEY_FILE / APPROVER_KEY_FILE，或 KEY_DIR（<KEY_DIR>/admin.key、approver.key）
//                               钥匙只在执行期从档案读；本机 anvil 没给时用 anvil 公开测试帐号 1、5
//   DRIVER_BROADCAST=1          非 anvil 链必须明确打开才会广播（只由操作者本人启动）
//   AUTO_EXECUTE=0              关掉冷静期满自动 execute
//   PORT=8700
import http from 'node:http'
import { encodeFunctionData, decodeEventLog, keccak256 } from 'viem'
import {
  decodeRevert,
  gasFromFile,
  gasLimit,
  guardedAdminAbi,
  loadAccount,
  loadDeployment,
  makeClient,
  shortErr,
  Signer,
  TOKEN_ABI,
  usingFallbackAbi,
  waitReceipt,
} from './lib.mjs'

const DEPLOYMENT = process.env.DEPLOYMENT ?? 'anvil'
const PORT = Number(process.env.PORT ?? 8700)
const IS_ANVIL_NAME = DEPLOYMENT === 'anvil'
const list = (s) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean)
const RPC_URLS = list(process.env.RPC_URLS).length
  ? list(process.env.RPC_URLS)
  : IS_ANVIL_NAME
    ? ['http://127.0.0.1:8545']
    : ['https://rpc-testnet.monadinfra.com', 'https://rpc.ankr.com/monad_testnet']
const BROADCAST_RPCS = list(process.env.BROADCAST_RPCS).length
  ? list(process.env.BROADCAST_RPCS)
  : IS_ANVIL_NAME
    ? RPC_URLS.slice(0, 1)
    : ['https://testnet-rpc.monad.xyz', 'https://rpc-testnet.monadinfra.com', 'https://rpc.ankr.com/monad_testnet']
const AUTO_EXECUTE = process.env.AUTO_EXECUTE !== '0'
const CARD_IMPL = { evilMint: 'evilMint', evilOwner: 'evilOwner', evilFee: 'evilFee', v2: 'v2', v1: 'v1' }

const readClients = RPC_URLS.map(makeClient)
const sendClients = BROADCAST_RPCS.map(makeClient)
let readIdx = 0
const rc = () => readClients[readIdx % readClients.length]

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), '[driver]', ...a)

// ---------- 启动：暖连线、确认链 ----------
let chainId
for (;;) {
  try {
    chainId = await rc().getChainId()
    break
  } catch (e) {
    log(`连不上 ${RPC_URLS[readIdx % RPC_URLS.length]}：${shortErr(e)}，1 秒后重试`)
    readIdx++
    await new Promise((r) => setTimeout(r, 1000))
  }
}
const MODE = chainId === 31337 ? 'replay' : 'testnet'
const CAN_BROADCAST = chainId === 31337 || process.env.DRIVER_BROADCAST === '1'
await Promise.allSettled(sendClients.map((c) => c.getBlockNumber())) // 暖广播连线

const admin = loadAccount('ADMIN', 'admin', 1, chainId)
const approver = loadAccount('APPROVER', 'approver', 5, chainId)
const adminSigner = admin ? new Signer(admin, chainId, rc(), sendClients) : null
const approverSigner = approver ? new Signer(approver, chainId, rc(), sendClients) : null
await Promise.allSettled([adminSigner?.syncNonce(), approverSigner?.syncNonce()])

function dep() {
  const d = loadDeployment(DEPLOYMENT)
  if (!d) throw httpErr(503, `shared/deployments/${DEPLOYMENT}.json 还不存在`)
  if (Number(d.chainId) !== chainId) throw httpErr(409, `部署档 chainId ${d.chainId} 与 RPC chainId ${chainId} 不符`)
  return d
}

function httpErr(code, msg) {
  const e = new Error(msg)
  e.code = code
  return e
}

// ---------- fee：背景每 10 秒更新，送交易时不现问 ----------
let fees = { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }
async function refreshFees() {
  try {
    const [blk, tip] = await Promise.all([
      rc().getBlock({ blockTag: 'latest' }),
      rc().request({ method: 'eth_maxPriorityFeePerGas' }).then(BigInt).catch(() => 2_000_000_000n),
    ])
    const base = blk.baseFeePerGas ?? (await rc().getGasPrice())
    fees = { maxFeePerGas: base * 2n + tip, maxPriorityFeePerGas: tip }
  } catch (e) {
    log('更新 fee 失败：', shortErr(e))
  }
}
await refreshFees()
setInterval(refreshFees, 10_000)

// ---------- SSE ----------
const clients = new Set()
const backlog = []
function emit(type, fields = {}) {
  const ev = { v: 1, type, ts: Date.now(), mode: MODE, source: 'driver', ...fields }
  const line = JSON.stringify(ev, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  if (type !== 'heartbeat') {
    backlog.push(line)
    if (backlog.length > 100) backlog.shift()
  }
  for (const res of clients) res.write(`data: ${line}\n\n`)
}

// ---------- 区块轮询：心跳＋冷静期满自动 execute ----------
let lastBlock = 0n
let rpcOk = true
const pendingExec = new Map() // id -> readyBlock
async function pollBlock() {
  try {
    lastBlock = await rc().getBlockNumber()
    rpcOk = true
    if (AUTO_EXECUTE) {
      for (const [id, ready] of pendingExec) {
        if (lastBlock >= ready) {
          pendingExec.delete(id)
          executeFlow(id).catch((e) => log(`自动 execute #${id} 失败：${shortErr(e)}`))
        }
      }
    }
  } catch {
    rpcOk = false
    readIdx++
  }
}
setInterval(pollBlock, 300)
setInterval(() => emit('heartbeat', { lastBlock: Number(lastBlock), rpc: new URL(RPC_URLS[readIdx % RPC_URLS.length]).host, ok: rpcOk }), 500)

// ---------- 动作 ----------
function requireBroadcast(signer, who) {
  if (!CAN_BROADCAST) throw httpErr(403, `chainId ${chainId} 未开放广播：操作者需以 DRIVER_BROADCAST=1 启动`)
  if (!signer) throw httpErr(503, `没有 ${who} 钥匙（设 ${who.toUpperCase()}_KEY_FILE 或 KEY_DIR）`)
}

async function proposeFlow(card) {
  const d = dep()
  const key = CARD_IMPL[card]
  if (!key) throw httpErr(400, `未知卡片 ${card}`)
  const impl = d.impls?.[key]
  if (!impl) throw httpErr(503, `部署档没有 impls.${key}`)
  requireBroadcast(adminSigner, 'admin')
  const abi = guardedAdminAbi()
  const data = encodeFunctionData({ abi, functionName: 'proposeUpgrade', args: [impl, '0x'] })
  // 预检：权限或参数有问题时直接回错误名称，不浪费交易
  try {
    await rc().call({ account: admin.address, to: d.guardedAdmin, data })
  } catch (e) {
    const r = decodeRevert(e, abi)
    throw httpErr(409, `proposeUpgrade 预检失败：${r.name ?? shortErr(e)}`)
  }
  const t0 = Date.now()
  const { hash, rpcs } = await adminSigner.send({ to: d.guardedAdmin, data, gas: gasLimit('propose'), fees })
  const rcpt = await waitReceipt(rc(), hash)
  if (rcpt.status !== 'success') throw httpErr(500, `proposeUpgrade 交易回滚 ${hash}`)
  let ev = null
  for (const lg of rcpt.logs) {
    if (lg.address.toLowerCase() !== d.guardedAdmin.toLowerCase()) continue
    try {
      const x = decodeEventLog({ abi, data: lg.data, topics: lg.topics })
      if (x.eventName === 'Proposed') ev = x.args
    } catch {
      /* 其他事件 */
    }
  }
  if (!ev) throw httpErr(500, `收据里找不到 Proposed 事件 ${hash}`)
  const id = ev.id.toString()
  const readyBlock = Number(ev.readyBlock)
  if (AUTO_EXECUTE) pendingExec.set(id, BigInt(readyBlock))
  const out = {
    ok: true,
    card,
    id,
    txHash: hash,
    proposeBlock: Number(rcpt.blockNumber),
    readyBlock,
    target: ev.target,
    codehash: ev.codehash,
    rpcs,
    ms: Date.now() - t0,
    autoExecute: AUTO_EXECUTE,
  }
  log(`提案 #${id}（${card}）块 ${out.proposeBlock} → 可执行 ${readyBlock}，tx ${hash}`)
  return out
}

async function executeFlow(idIn) {
  const d = dep()
  const id = BigInt(idIn)
  requireBroadcast(adminSigner, 'admin')
  const abi = guardedAdminAbi()
  const data = encodeFunctionData({ abi, functionName: 'execute', args: [id] })
  // 1) eth_call 先拿错误名称（例如 ProposalVetoed）
  let preflight = null
  let preflightArgs = []
  try {
    await rc().call({ account: admin.address, to: d.guardedAdmin, data })
  } catch (e) {
    const r = decodeRevert(e, abi)
    preflight = r.name ?? shortErr(e)
    preflightArgs = r.args
  }
  if (preflight === 'UnknownProposal') throw httpErr(404, `提案 #${id} 不存在（UnknownProposal），不送交易`)
  // 2) 照样用固定 gas limit 真的送出（不估 gas），让画面同时有错误名称与 revert 交易
  const { hash, rpcs } = await adminSigner.send({ to: d.guardedAdmin, data, gas: gasLimit('execute'), fees })
  const rcpt = await waitReceipt(rc(), hash)
  const success = rcpt.status === 'success'
  let version = null
  if (success) {
    try {
      version = await rc().readContract({ address: d.proxy, abi: TOKEN_ABI, functionName: 'version' })
    } catch {
      version = null // v1 没有 version()
    }
  }
  const out = {
    id: id.toString(),
    txHash: hash,
    result: success ? 'success' : 'reverted',
    error: success ? null : (preflight ?? 'unknown'),
    extra: {
      preflight,
      preflightArgs,
      block: Number(rcpt.blockNumber),
      gasUsed: rcpt.gasUsed.toString(),
      gasLimit: gasLimit('execute').toString(),
      effectiveGasPrice: rcpt.effectiveGasPrice?.toString() ?? null,
      version,
      rpcs,
    },
  }
  // 太早送的（TooEarly）保留自动 execute；其余结果都算处理完
  if (success || preflight !== 'TooEarly') pendingExec.delete(out.id)
  emit('execute_attempt', out)
  log(`execute #${out.id} → ${out.result}${out.error ? ` ${out.error}` : ''}${version ? ` version()="${version}"` : ''} tx ${hash}`)
  return out
}

async function approveFlow(body) {
  const d = dep()
  requireBroadcast(approverSigner, 'approver')
  let codehash = body.codehash
  if (!codehash && body.card) {
    const key = CARD_IMPL[body.card]
    const impl = key && d.impls?.[key]
    if (!impl) throw httpErr(400, `未知卡片 ${body.card}`)
    const code = await rc().getCode({ address: impl })
    if (!code || code === '0x') throw httpErr(409, `${impl} 没有 code`)
    codehash = keccak256(code)
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(codehash ?? '')) throw httpErr(400, '要给 codehash 或 card')
  const abi = guardedAdminAbi()
  const data = encodeFunctionData({ abi, functionName: 'approveCodehash', args: [codehash] })
  try {
    await rc().call({ account: approver.address, to: d.guardedAdmin, data })
  } catch (e) {
    throw httpErr(409, `approveCodehash 预检失败：${decodeRevert(e, abi).name ?? shortErr(e)}`)
  }
  const { hash } = await approverSigner.send({ to: d.guardedAdmin, data, gas: gasLimit('approveCodehash'), fees })
  const rcpt = await waitReceipt(rc(), hash)
  log(`approveCodehash ${codehash} → ${rcpt.status} tx ${hash}`)
  return { ok: rcpt.status === 'success', codehash, txHash: hash, block: Number(rcpt.blockNumber) }
}

// ---------- HTTP ----------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
}
const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...CORS })
  res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
}
const readBody = (req) =>
  new Promise((resolve, reject) => {
    let buf = ''
    req.on('data', (c) => {
      buf += c
      if (buf.length > 16_000) reject(httpErr(413, 'body too large'))
    })
    req.on('end', () => {
      try {
        resolve(buf ? JSON.parse(buf) : {})
      } catch {
        reject(httpErr(400, 'body 不是 JSON'))
      }
    })
    req.on('error', reject)
  })

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS)
    return res.end()
  }
  try {
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...CORS })
      res.write(': connected\n\n')
      const n = Math.min(Number(url.searchParams.get('backlog') ?? 0) || 0, backlog.length)
      for (const line of backlog.slice(backlog.length - n)) res.write(`data: ${line}\n\n`)
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      const d = loadDeployment(DEPLOYMENT)
      return json(res, 200, {
        ok: rpcOk,
        chainId,
        mode: MODE,
        lastBlock: Number(lastBlock),
        deployment: d ? DEPLOYMENT : null,
        broadcast: CAN_BROADCAST,
        admin: admin?.address ?? null,
        approver: approver?.address ?? null,
        adminMatchesOwner: d && admin ? d.owner?.toLowerCase() === admin.address.toLowerCase() : null,
        abi: usingFallbackAbi() ? 'fallback(spec 3.3)' : 'shared/abi',
        gas: gasFromFile() ? 'shared/gas.json' : 'fallback',
        pendingExecute: [...pendingExec].map(([id, b]) => ({ id, readyBlock: Number(b) })),
      })
    }
    if (req.method === 'GET' && url.pathname === '/deployments') {
      const d = dep()
      // 只给公开位址，不含任何钥匙资讯
      return json(res, 200, {
        chainId: d.chainId,
        guardedAdmin: d.guardedAdmin,
        proxy: d.proxy,
        proxyAdmin: d.proxyAdmin,
        impls: d.impls,
        owner: d.owner,
        guardians: d.guardians,
        approver: d.approver,
        deployBlock: d.deployBlock,
      })
    }
    if (req.method === 'POST' && url.pathname === '/propose') {
      const b = await readBody(req)
      return json(res, 200, await proposeFlow(String(b.card ?? '')))
    }
    if (req.method === 'POST' && url.pathname === '/execute') {
      const b = await readBody(req)
      if (b.id === undefined) throw httpErr(400, '要给 id')
      return json(res, 200, await executeFlow(String(b.id)))
    }
    if (req.method === 'POST' && url.pathname === '/approve') {
      return json(res, 200, await approveFlow(await readBody(req)))
    }
    json(res, 404, { error: 'not found' })
  } catch (e) {
    json(res, e.code && Number.isInteger(e.code) && e.code >= 400 ? e.code : 500, { error: shortErr(e) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  log(`listening 127.0.0.1:${PORT} chainId=${chainId} mode=${MODE} broadcast=${CAN_BROADCAST} deployment=${DEPLOYMENT}`)
  log(`admin=${admin?.address ?? '（无）'} approver=${approver?.address ?? '（无）'} abi=${usingFallbackAbi() ? 'fallback' : 'shared'} gas=${gasFromFile() ? 'shared/gas.json' : 'fallback'}`)
})
