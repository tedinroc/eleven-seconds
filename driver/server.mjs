#!/usr/bin/env node
// 战情室 driver（127.0.0.1:8700）：替画面送提案、冷静期满自动 execute、approver 预核准 codehash。
//
//   POST /propose  {"card":"evilMint"|"evilOwner"|"evilFee"|"v2"|"v1"}   admin 送 proposeUpgrade(impl, 0x)
//   POST /execute  {"id":"3"}      先 eth_call 拿错误名称，再用 gas.json 的固定 gas limit 真的送出
//   POST /approve  {"card":"v2"} 或 {"codehash":"0x…"}   approver 送 approveCodehash（严格模式用）
//   POST /demo/sentinel {"n":3,"action":"stop"|"start"}   stage helper: stop or restart one sentinel (local only)
//   GET  /events   SSE（spec 4.4：heartbeat、execute_attempt）   GET /health   GET /deployments
//
// 环境变数：
//   DEPLOYMENT=anvil|10143      读 shared/deployments/<DEPLOYMENT>.json（预设 anvil）
//   RPC_URLS=a,b,c              读取／收据用，依序偏好（anvil 预设 http://127.0.0.1:8545；
//                               测试网预设 ankr、官方、monadinfra）。连线类错误立刻换下一家，失败的暂时排最后
//   BROADCAST_RPCS=a,b,c        广播用，同一笔 raw tx 同时送（测试网预设 官方、ankr、monadinfra），第一家接受就回
//   RPC_TIMEOUT_MS=3000         读取单次请求上限；SEND_TIMEOUT_MS=6000 广播单次上限
//   WARM_MS=12000               暖机间隔（启动时也暖一次；Node keep-alive 拉长到 60 秒）
//   ADMIN_KEY_FILE / APPROVER_KEY_FILE，或 KEY_DIR（<KEY_DIR>/admin.key、approver.key）
//                               钥匙只在执行期从档案读；本机 anvil 没给时用 anvil 公开测试帐号 1、5
//   DRIVER_BROADCAST=1          非 anvil 链必须明确打开才会广播（只由操作者本人启动）
//   AUTO_EXECUTE=0              关掉冷静期满自动 execute
//   PORT=8700
import http from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { openSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { encodeFunctionData, decodeEventLog, keccak256 } from 'viem'
import {
  decodeRevert,
  extendKeepAlive,
  gasFromFile,
  gasLimit,
  guardedAdminAbi,
  isContractAnswer,
  loadAccount,
  loadDeployment,
  RpcPool,
  rpcHealth,
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
const OFFICIAL = 'https://testnet-rpc.monad.xyz'
const ANKR = 'https://rpc.ankr.com/monad_testnet'
const MONADINFRA = 'https://rpc-testnet.monadinfra.com'
// 读取顺序依 2026-10-17 会场网路实测排序；官方每 IP 每秒 15 次，只当第二顺位
const RPC_URLS = list(process.env.RPC_URLS).length
  ? list(process.env.RPC_URLS)
  : IS_ANVIL_NAME
    ? ['http://127.0.0.1:8545']
    : [ANKR, OFFICIAL, MONADINFRA]
const BROADCAST_RPCS = list(process.env.BROADCAST_RPCS).length
  ? list(process.env.BROADCAST_RPCS)
  : IS_ANVIL_NAME
    ? RPC_URLS.slice(0, 1)
    : [OFFICIAL, ANKR, MONADINFRA]
const AUTO_EXECUTE = process.env.AUTO_EXECUTE !== '0'
const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS ?? 3_000)
const SEND_TIMEOUT_MS = Number(process.env.SEND_TIMEOUT_MS ?? 6_000)
const WARM_MS = Number(process.env.WARM_MS ?? 12_000)
const CARD_IMPL = { evilMint: 'evilMint', evilOwner: 'evilOwner', evilFee: 'evilFee', v2: 'v2', v1: 'v1' }

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), '[driver]', ...a)

const keepAlive = await extendKeepAlive(60_000)
const readPool = new RpcPool('read', RPC_URLS, { timeout: RPC_TIMEOUT_MS })
const sendPool = new RpcPool('send', BROADCAST_RPCS, { timeout: SEND_TIMEOUT_MS })
const rc = () => readPool.client

// ---------- 启动：暖连线、确认链 ----------
await Promise.allSettled([readPool.warm(), sendPool.warm()]) // 先把每家的 TLS 连线建好
let chainId
for (;;) {
  try {
    chainId = await rc().getChainId()
    break
  } catch (e) {
    log(`每家读取 RPC 都连不上（${shortErr(e)}），1 秒后重试`)
    await new Promise((r) => setTimeout(r, 1000))
  }
}
const MODE = chainId === 31337 ? 'replay' : 'testnet'
const CAN_BROADCAST = chainId === 31337 || process.env.DRIVER_BROADCAST === '1'

// 定时暖机：WARM_MS 内没成功用过的端点打一个 eth_blockNumber，让广播那几家的连线一直是热的
let warming = false
setInterval(async () => {
  if (warming) return
  warming = true
  try {
    // 读与广播共用同一家的端点状态：先后跑，第二个就会跳过刚暖过的那家
    await readPool.warm(WARM_MS * 0.8)
    await sendPool.warm(WARM_MS * 0.8)
  } finally {
    warming = false
  }
}, WARM_MS).unref?.()
// 失败中的端点每 3 秒背景探测一次，成功就回到原本顺位
setInterval(() => {
  readPool.probeDown()
  sendPool.probeDown()
}, 3_000).unref?.()

const admin = loadAccount('ADMIN', 'admin', 1, chainId)
const approver = loadAccount('APPROVER', 'approver', 5, chainId)
const adminSigner = admin ? new Signer(admin, chainId, rc(), sendPool) : null
const approverSigner = approver ? new Signer(approver, chainId, rc(), sendPool) : null
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
// 更新失败就沿用上次的值；从没成功过才在送交易当下现问一次（再失败用保守的预设值）
let fees = null
let feesAt = 0
async function fetchFees() {
  const [blk, tip] = await Promise.all([
    rc().getBlock({ blockTag: 'latest' }),
    rc().request({ method: 'eth_maxPriorityFeePerGas' }).then(BigInt).catch(() => 2_000_000_000n),
  ])
  const base = blk.baseFeePerGas ?? (await rc().getGasPrice())
  return { maxFeePerGas: base * 2n + tip, maxPriorityFeePerGas: tip }
}
async function refreshFees() {
  try {
    fees = await fetchFees()
    feesAt = Date.now()
  } catch (e) {
    log(`更新 fee 失败（沿用${fees ? '上次的值' : '预设值'}）：`, shortErr(e))
  }
}
const FEE_DEFAULT = { maxFeePerGas: 250_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n } // 实测 base 约 100 gwei
async function currentFees() {
  if (fees) return fees
  await refreshFees()
  return fees ?? FEE_DEFAULT
}
await refreshFees()
setInterval(refreshFees, 10_000).unref?.()

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
let lastPollOkAt = 0
let polling = false
/** id -> { readyBlock, inFlight, fails, skips, nextTryAt, sent }；只有拿到明确结果才移除 */
const pendingExec = new Map()
const execBusy = new Set() // 正在 execute 的 id（手动与自动互斥）
async function pollBlock() {
  if (polling) return // 某家很慢时不要叠请求
  polling = true
  try {
    const b = await rc().getBlockNumber()
    // 几家 RPC 可能差一两块：只往前走（anvil 重开、块高大幅倒退时才接受）
    if (b > lastBlock || lastBlock - b > 20n) lastBlock = b
    lastPollOkAt = Date.now()
  } catch {
    /* 这一轮每家都失败；下一轮再试（RpcPool 已把坏的排到后面） */
  } finally {
    polling = false
    tickAuto()
  }
}
setInterval(pollBlock, 300)
const rpcOk = () => Date.now() - lastPollOkAt < 2_000
setInterval(() => emit('heartbeat', { lastBlock: Number(lastBlock), rpc: readPool.lastUsed?.host ?? '', ok: rpcOk() }), 500)

function scheduleAuto(id, readyBlock) {
  if (!AUTO_EXECUTE) return
  if (!pendingExec.has(id)) pendingExec.set(id, { readyBlock: BigInt(readyBlock), inFlight: false, fails: 0, skips: 0, nextTryAt: 0, sent: null })
}

function tickAuto() {
  if (!AUTO_EXECUTE) return
  const now = Date.now()
  for (const [id, ent] of pendingExec) {
    if (ent.inFlight || execBusy.has(id) || lastBlock < ent.readyBlock || now < ent.nextTryAt) continue
    runAuto(id, ent)
  }
}

async function runAuto(id, ent) {
  ent.inFlight = true
  execBusy.add(id)
  try {
    let out
    if (ent.sent) {
      // 上一次已经广播出去、只是没等到收据：先接着等同一笔，不要重送（重送会变成 AlreadyExecuted）
      try {
        const { hash, rpcs, preflight, preflightArgs } = ent.sent
        out = await finishExecute(dep(), id, hash, rpcs, preflight, preflightArgs, 10_000)
      } catch (e) {
        ent.sentWaits = (ent.sentWaits ?? 0) + 1
        if (ent.sentWaits >= 3) ent.sent = null // 等了够久，当作没进链，重送
        throw e
      }
    } else {
      out = await executeFlow(id, { auto: true })
    }
    if (out.skipped === 'AlreadyExecuted') {
      // 先前那笔其实进链了（广播回报失败但有一家收到），或有人手动 execute：补发成功事件，画面才会显示已生效
      pendingExec.delete(id)
      await reportAlreadyExecuted(id, ent).catch((e) => log(`自动 execute #${id}：已被执行，但补发事件失败：${shortErr(e)}`))
    } else if (out.skipped) {
      // 预检 TooEarly：读到的那家落后一两块，不浪费交易，300 ms 后再试
      if (++ent.skips > 400) {
        pendingExec.delete(id)
        log(`自动 execute #${id}：预检一直 TooEarly，放弃`)
      } else ent.nextTryAt = Date.now() + 300
    } else if (pendingExec.has(id)) {
      ent.nextTryAt = Date.now() + 300 // 链上 TooEarly：保留，下一块再试
    }
  } catch (e) {
    ent.fails++
    if (e.code === 404 || ent.fails >= 30) {
      pendingExec.delete(id)
      log(`自动 execute #${id} 放弃：${shortErr(e)}`)
    } else {
      ent.nextTryAt = Date.now() + Math.min(3_000, 300 * ent.fails)
      log(`自动 execute #${id} 第 ${ent.fails} 次失败，${ent.nextTryAt - Date.now()} ms 后重试：${shortErr(e)}`)
    }
  } finally {
    ent.inFlight = false
    execBusy.delete(id)
  }
}

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
    if (!isContractAnswer(e)) throw httpErr(502, `proposeUpgrade 预检时每家 RPC 都失败：${shortErr(e)}`)
    const r = decodeRevert(e, abi)
    throw httpErr(409, `proposeUpgrade 预检失败：${r.name ?? shortErr(e)}`)
  }
  const t0 = Date.now()
  const { hash, rpcs } = await adminSigner.send({ to: d.guardedAdmin, data, gas: gasLimit('propose'), fees: currentFees })
  let rcpt
  try {
    rcpt = await waitReceipt(rc(), hash)
  } catch (e) {
    // 已经广播出去：背景继续等收据，等到就照样排自动 execute
    waitReceipt(rc(), hash, 120_000)
      .then((r) => {
        const ev = proposedEvent(r, d, abi)
        if (r.status === 'success' && ev) {
          scheduleAuto(ev.id.toString(), ev.readyBlock)
          log(`提案 tx ${hash} 晚到的收据：#${ev.id} 可执行 ${ev.readyBlock}，已排自动 execute`)
        }
      })
      .catch(() => log(`提案 tx ${hash} 两分钟内都没等到收据`))
    throw httpErr(504, `${shortErr(e)}（背景继续等，进链后会自动排 execute）`)
  }
  if (rcpt.status !== 'success') throw httpErr(500, `proposeUpgrade 交易回滚 ${hash}`)
  const ev = proposedEvent(rcpt, d, abi)
  if (!ev) throw httpErr(500, `收据里找不到 Proposed 事件 ${hash}`)
  const id = ev.id.toString()
  const readyBlock = Number(ev.readyBlock)
  scheduleAuto(id, readyBlock)
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

function proposedEvent(rcpt, d, abi) {
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
  return ev
}

/** 已被执行的提案：从 Executed log 找出那笔交易，照 execute_attempt 格式补发 */
async function reportAlreadyExecuted(sid, ent) {
  const d = dep()
  const abi = guardedAdminAbi()
  const event = abi.find((x) => x.type === 'event' && x.name === 'Executed')
  const logs = await rc().getLogs({ address: d.guardedAdmin, event, args: { id: BigInt(sid) }, fromBlock: ent.readyBlock, toBlock: 'latest' })
  const hit = logs.at(-1)
  if (!hit) throw new Error(`找不到 Executed(#${sid}) log`)
  let version = null
  try {
    version = await rc().readContract({ address: d.proxy, abi: TOKEN_ABI, functionName: 'version' })
  } catch {
    version = null
  }
  const out = {
    id: sid,
    txHash: hit.transactionHash,
    result: 'success',
    error: null,
    extra: { preflight: 'AlreadyExecuted', block: Number(hit.blockNumber), executor: hit.args?.executor ?? null, version, recovered: true },
  }
  emit('execute_attempt', out)
  log(`execute #${sid} 已由 tx ${hit.transactionHash} 执行（块 ${out.extra.block}），补发 execute_attempt`)
  return out
}

/** auto=true（冷静期满自动触发）：预检 TooEarly／AlreadyExecuted 时不送交易，交给 runAuto 再排 */
async function executeFlow(idIn, { auto = false } = {}) {
  const d = dep()
  const id = BigInt(idIn)
  const sid = id.toString()
  requireBroadcast(adminSigner, 'admin')
  const abi = guardedAdminAbi()
  const data = encodeFunctionData({ abi, functionName: 'execute', args: [id] })
  // 1) eth_call 先拿错误名称（例如 ProposalVetoed）
  let preflight = null
  let preflightArgs = []
  try {
    await rc().call({ account: admin.address, to: d.guardedAdmin, data })
  } catch (e) {
    if (!isContractAnswer(e)) throw httpErr(502, `execute 预检时每家 RPC 都失败：${shortErr(e)}`)
    const r = decodeRevert(e, abi)
    preflight = r.name ?? shortErr(e)
    preflightArgs = r.args
  }
  if (preflight === 'UnknownProposal') {
    pendingExec.delete(sid)
    throw httpErr(404, `提案 #${id} 不存在（UnknownProposal），不送交易`)
  }
  if (auto && (preflight === 'TooEarly' || preflight === 'AlreadyExecuted')) return { id: sid, skipped: preflight }
  // 2) 照样用固定 gas limit 真的送出（不估 gas），让画面同时有错误名称与 revert 交易
  const { hash, rpcs } = await adminSigner.send({ to: d.guardedAdmin, data, gas: gasLimit('execute'), fees: currentFees })
  const ent = pendingExec.get(sid)
  if (ent) ent.sent = { hash, rpcs, preflight, preflightArgs }
  return finishExecute(d, sid, hash, rpcs, preflight, preflightArgs)
}

async function finishExecute(d, sid, hash, rpcs, preflight, preflightArgs, timeoutMs = 30_000) {
  const abi = guardedAdminAbi()
  const rcpt = await waitReceipt(rc(), hash, timeoutMs)
  const success = rcpt.status === 'success'
  let version = null
  if (success) {
    try {
      version = await rc().readContract({ address: d.proxy, abi: TOKEN_ABI, functionName: 'version' })
    } catch {
      version = null // v1 没有 version()
    }
  }
  let error = success ? null : preflight
  if (!success && !error) {
    // 预检通过却回滚（例如读到的那家落后）：现在再 eth_call 一次补上错误名称
    try {
      await rc().call({ account: admin.address, to: d.guardedAdmin, data: encodeFunctionData({ abi, functionName: 'execute', args: [BigInt(sid)] }) })
    } catch (e) {
      if (isContractAnswer(e)) error = decodeRevert(e, abi).name
    }
    error ??= 'unknown'
  }
  const out = {
    id: sid,
    txHash: hash,
    result: success ? 'success' : 'reverted',
    error,
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
  const ent = pendingExec.get(sid)
  if (success || error !== 'TooEarly') pendingExec.delete(sid)
  else if (ent) ent.sent = null
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
    if (!isContractAnswer(e)) throw httpErr(502, `approveCodehash 预检时每家 RPC 都失败：${shortErr(e)}`)
    throw httpErr(409, `approveCodehash 预检失败：${decodeRevert(e, abi).name ?? shortErr(e)}`)
  }
  const { hash } = await approverSigner.send({ to: d.guardedAdmin, data, gas: gasLimit('approveCodehash'), fees: currentFees })
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

// Stage helper: stop / restart one sentinel so the audience can see the other two still veto.
// Local only (the driver listens on 127.0.0.1). stop = SIGTERM to the node process listening on 870<n>.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
function sentinelPid(n) {
  try {
    const out = execFileSync('lsof', ['-nP', '-t', `-iTCP:${8700 + n}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim()
    const pid = Number(out.split('\n')[0])
    if (!pid) return null
    const comm = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    return /node/.test(comm) ? pid : null
  } catch { return null }
}
function sentinelControl(n, action) {
  if (![1, 2, 3].includes(n)) throw Object.assign(new Error('n must be 1, 2 or 3'), { code: 400 })
  const pid = sentinelPid(n)
  if (action === 'stop') {
    if (!pid) return { ok: true, n, already: 'stopped' }
    process.kill(pid, 'SIGTERM')
    return { ok: true, n, stopped: pid }
  }
  if (action === 'start') {
    if (pid) return { ok: true, n, already: 'running', pid }
    mkdirSync(path.join(REPO_ROOT, '.demo'), { recursive: true })
    const log = openSync(path.join(REPO_ROOT, '.demo', `sentinel-${n}.log`), 'a')
    const child = spawn('sh', ['sentinel/run.sh', MODE === 'testnet' ? 'testnet' : 'anvil'], {
      cwd: REPO_ROOT, env: { ...process.env, ONLY: String(n) }, detached: true, stdio: ['ignore', log, log],
    })
    child.unref()
    return { ok: true, n, starting: child.pid }
  }
  throw Object.assign(new Error('action must be stop or start'), { code: 400 })
}

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
        ok: rpcOk(),
        chainId,
        mode: MODE,
        lastBlock: Number(lastBlock),
        lastBlockAgoMs: lastPollOkAt ? Date.now() - lastPollOkAt : null,
        rpc: {
          read: readPool.order().map((e) => e.host),
          send: sendPool.order().map((e) => e.host),
          lastRead: readPool.lastUsed?.host ?? null,
          keepAlive,
          warmMs: WARM_MS,
          endpoints: rpcHealth(),
        },
        fees: fees ? { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, ageMs: Date.now() - feesAt } : null,
        deployment: d ? DEPLOYMENT : null,
        broadcast: CAN_BROADCAST,
        admin: admin?.address ?? null,
        approver: approver?.address ?? null,
        adminMatchesOwner: d && admin ? d.owner?.toLowerCase() === admin.address.toLowerCase() : null,
        abi: usingFallbackAbi() ? 'fallback(spec 3.3)' : 'shared/abi',
        gas: gasFromFile() ? 'shared/gas.json' : 'fallback',
        pendingExecute: [...pendingExec].map(([id, e]) => ({
          id,
          readyBlock: Number(e.readyBlock),
          inFlight: e.inFlight,
          fails: e.fails,
          sentTx: e.sent?.hash ?? null,
        })),
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
      const sid = String(b.id)
      if (!/^\d+$/.test(sid)) throw httpErr(400, 'id 要是十进位整数')
      if (execBusy.has(sid)) throw httpErr(409, `execute #${sid} 正在进行中`)
      execBusy.add(sid)
      try {
        return json(res, 200, await executeFlow(sid))
      } finally {
        execBusy.delete(sid)
      }
    }
    if (req.method === 'POST' && url.pathname === '/demo/sentinel') {
      const b = await readBody(req)
      return json(res, 200, sentinelControl(Number(b.n), String(b.action ?? '')))
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
  log(`read RPC：${RPC_URLS.map((u) => new URL(u).host).join(' → ')}；broadcast：${BROADCAST_RPCS.map((u) => new URL(u).host).join(' + ')}；keep-alive ${keepAlive ? '60s' : '预设'}，暖机每 ${WARM_MS} ms`)
  log(`admin=${admin?.address ?? '（无）'} approver=${approver?.address ?? '（无）'} abi=${usingFallbackAbi() ? 'fallback' : 'shared'} gas=${gasFromFile() ? 'shared/gas.json' : 'fallback'}`)
})
