// driver 共用：读 shared/（部署位址、ABI、gas）、在执行期从档案读钥匙、本地 nonce、签名与多路广播。
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, custom, decodeErrorResult, http, keccak256, parseAbi } from 'viem'
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts'

export const SHARED_DIR = process.env.SHARED_DIR ?? fileURLToPath(new URL('../shared/', import.meta.url))

// ---------- shared/ 读取（档案变动就重读，A 线重新部署后不必重启 driver） ----------
const cache = new Map()
function readJsonCached(rel) {
  const p = join(SHARED_DIR, rel)
  let st
  try {
    st = statSync(p)
  } catch {
    cache.delete(rel)
    return null
  }
  const hit = cache.get(rel)
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.value
  const value = JSON.parse(readFileSync(p, 'utf8'))
  cache.set(rel, { mtimeMs: st.mtimeMs, value })
  return value
}

/** spec 3.3–3.5 的最小 ABI；shared/abi 有档案时一律用 A 线产出的版本 */
const FALLBACK_GUARDED_ADMIN = parseAbi([
  'function proposeUpgrade(address newImpl, bytes data) returns (uint256 id)',
  'function execute(uint256 id)',
  'function approveCodehash(bytes32 codehash)',
  'function nextId() view returns (uint256)',
  'function delayBlocks() view returns (uint64)',
  'function isWired() view returns (bool)',
  'function getProposal(uint256 id) view returns (uint8 kind, uint8 status, address proposer, address target, uint256 value, bytes32 codehash, bytes32 dataHash, uint64 proposedBlock, uint64 readyBlock, uint256 vetoCount)',
  'event Proposed(uint256 indexed id, uint8 indexed kind, address indexed target, uint256 value, bytes data, bytes32 codehash, uint64 readyBlock)',
  'event Executed(uint256 indexed id, address executor)',
  'error NotOwner()',
  'error NotGuardian()',
  'error NotApprover()',
  'error NotOwnerOrGuardian()',
  'error UnknownProposal(uint256 id)',
  'error TooEarly(uint256 id, uint64 readyBlock, uint64 currentBlock)',
  'error ProposalVetoed(uint256 id)',
  'error AlreadyExecuted(uint256 id)',
  'error InvalidDelay(uint64 value)',
  'error GuardianBounds(uint256 count)',
  'error ZeroAddress()',
  'error NoCode(address target)',
  'error AlreadyPaused()',
])

export const TOKEN_ABI = parseAbi(['function version() view returns (string)', 'function totalSupply() view returns (uint256)'])

function abiOf(json) {
  if (!json) return null
  return Array.isArray(json) ? json : Array.isArray(json.abi) ? json.abi : null
}

export function guardedAdminAbi() {
  return abiOf(readJsonCached('abi/GuardedAdmin.json')) ?? FALLBACK_GUARDED_ADMIN
}

export function usingFallbackAbi() {
  return !abiOf(readJsonCached('abi/GuardedAdmin.json'))
}

export function loadDeployment(name) {
  return readJsonCached(`deployments/${name}.json`)
}

const GAS_FALLBACK = { propose: 200_000n, execute: 150_000n, approveCodehash: 80_000n }
/** gas limit 一律读 shared/gas.json（anvil 实际收据 ×1.10），不估 gas */
export function gasLimit(key) {
  const g = readJsonCached('gas.json')
  const v = g?.[key]
  const n = typeof v === 'number' ? v : (v?.gasLimit ?? v?.limit ?? v?.suggested)
  if (n) return BigInt(n)
  return GAS_FALLBACK[key]
}

export function gasFromFile() {
  return !!readJsonCached('gas.json')
}

// ---------- 钥匙 ----------
// anvil 内建的公开测试助记词（人人皆知，只在 chainId 31337 使用）
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk'

/**
 * 钥匙只在执行期从档案读：<ENV>_KEY_FILE，或 KEY_DIR/<label>.key。内容不印、不记录。
 * 只有本机 anvil（31337）才退回 anvil 公开测试帐号。
 */
export function loadAccount(envPrefix, label, anvilIndex, chainId) {
  let file = process.env[`${envPrefix}_KEY_FILE`]
  if (!file && process.env.KEY_DIR) file = join(process.env.KEY_DIR, `${label}.key`)
  if (file) {
    let raw
    try {
      raw = readFileSync(file, 'utf8').replace(/\s+/g, '')
    } catch {
      throw new Error(`${envPrefix}_KEY_FILE 读不到`)
    }
    const pk = raw.startsWith('0x') ? raw : `0x${raw}`
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error(`${envPrefix}_KEY_FILE 格式不对（要一行 hex 私钥）`)
    return privateKeyToAccount(pk)
  }
  if (chainId === 31337) return mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: anvilIndex })
  return null
}

// ---------- RPC ----------
// 会场网路：新建 TLS 1.3–1.7 s、偶发 "tls handshake eof"；保持连线后约 320 ms。
// 所以：(1) 拉长 Node fetch 的 idle keep-alive（预设只有 4 秒），配合定时暖机；
//       (2) 每家端点各自记录成功／失败，连线类错误立刻换下一家，失败的暂时排到最后。

/** Node 内建 fetch（undici）预设 idle 4 秒就关连线；换成 keep-alive 较长的 Agent。失败就维持预设。 */
export async function extendKeepAlive(keepAliveMs = 60_000) {
  const sym = Symbol.for('undici.globalDispatcher.1')
  try {
    if (!globalThis[sym]) await fetch('data:,').catch(() => {}) // 让 Node 建出预设 dispatcher
    const Agent = globalThis[sym]?.constructor
    if (typeof Agent !== 'function') return false
    const agent = new Agent({ keepAliveTimeout: keepAliveMs, keepAliveMaxTimeout: keepAliveMs * 2 })
    globalThis[sym] = agent // undici 自己定义成 writable、non-configurable，直接赋值即可
    return globalThis[sym] === agent
  } catch {
    return false
  }
}

const hostOf = (url) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** 错误链里有 revert data／revert 字样 = 链上的答案（端点本身是好的），不换家、不算失败 */
export function isContractAnswer(err) {
  let e = err
  for (let i = 0; i < 10 && e; i++) {
    const d = typeof e.data === 'string' ? e.data : typeof e.data?.data === 'string' ? e.data.data : null
    if (d && d.startsWith('0x') && d.length > 2) return true
    if (e.code === 3) return true
    if (/execution reverted|revert/i.test(String(e.details ?? '')) || /execution reverted/i.test(String(e.shortMessage ?? ''))) return true
    e = e.cause
  }
  return false
}

const endpoints = new Map() // url -> 端点状态（读与广播共用，健康资讯以 URL 为单位）
function endpoint(url, timeout) {
  let ep = endpoints.get(url)
  if (!ep) {
    ep = {
      url,
      host: hostOf(url),
      transports: new Map(),
      ok: 0,
      fail: 0,
      consecutiveFails: 0,
      lastOkAt: 0,
      lastFailAt: 0,
      lastErr: null,
      lastMs: null,
      probing: false,
    }
    endpoints.set(url, ep)
  }
  if (!ep.transports.has(timeout)) {
    // retryCount 0：重试交给轮替，不在同一家原地重试
    ep.transports.set(timeout, http(url, { timeout, retryCount: 0, batch: false })({ retryCount: 0 }))
  }
  return ep
}

function markOk(ep, ms) {
  ep.ok++
  ep.consecutiveFails = 0
  ep.lastOkAt = Date.now()
  ep.lastMs = ms
}

function markFail(ep, err) {
  ep.fail++
  ep.consecutiveFails++
  ep.lastFailAt = Date.now()
  ep.lastErr = shortErr(err)
}

async function timed(ep, timeout, args) {
  const t0 = Date.now()
  try {
    const r = await ep.transports.get(timeout).request(args)
    markOk(ep, Date.now() - t0)
    return r
  } catch (e) {
    if (isContractAnswer(e)) markOk(ep, Date.now() - t0)
    else markFail(ep, e)
    throw e
  }
}

export class RpcPool {
  /** urls 依偏好顺序；timeout 是单次请求上限（毫秒） */
  constructor(name, urls, { timeout = 3_000 } = {}) {
    this.name = name
    this.timeout = timeout
    this.eps = urls.map((u) => endpoint(u, timeout))
    this.lastUsed = null
    const request = (args) => this.request(args)
    // cacheTime 0：viem 预设会把 getBlockNumber 快取 4 秒，自动 execute 会因此晚好几块
    this.client = createPublicClient({ transport: custom({ request }, { retryCount: 0 }), cacheTime: 0, pollingInterval: 250 })
  }

  /**
   * 健康的照设定顺序在前；最近一次失败的排后面（连续失败少的先），
   * 直到背景探测（probeDown／warm）成功一次才回到原位，免得正式请求再去等一家坏掉的逾时
   */
  order() {
    const up = this.eps.filter((e) => e.consecutiveFails === 0)
    const down = this.eps.filter((e) => e.consecutiveFails > 0).sort((a, b) => a.consecutiveFails - b.consecutiveFails)
    return [...up, ...down]
  }

  /** 背景探测失败中的端点（同一家同时只探一个，逾时的不会叠） */
  async probeDown() {
    await Promise.allSettled(
      this.eps
        .filter((ep) => ep.consecutiveFails > 0 && !ep.probing)
        .map(async (ep) => {
          ep.probing = true
          try {
            await timed(ep, this.timeout, { method: 'eth_blockNumber' })
          } finally {
            ep.probing = false
          }
        }),
    )
  }

  /** 依序试每一家：链上答案（revert）直接丢回；连线／限流／逾时立刻换下一家 */
  async request(args) {
    let last
    for (const ep of this.order()) {
      try {
        const r = await timed(ep, this.timeout, args)
        this.lastUsed = ep
        return r
      } catch (e) {
        if (isContractAnswer(e)) {
          this.lastUsed = ep
          throw e
        }
        last = e
      }
    }
    throw last ?? new Error(`${this.name}：没有可用的 RPC`)
  }

  /**
   * 同一笔 raw tx 同时送给每一家；第一家接受就回（不等慢的那家），其余在背景跑完、照样记健康。
   * 「already known」视为已收到（另一家先广播过去了）；「nonce too low」只有在别家接受／already known 时才算，
   * 每家都说 nonce too low ＝本地 nonce 过期（例如操作者用 cast 手动送过），丢回让 Signer 重新同步。
   */
  broadcast(signed) {
    return new Promise((resolve, reject) => {
      let accepted = 0
      let soft = 0
      let nonceLow = 0
      let settled = 0
      const errs = []
      let done = false
      const finish = () => {
        if (done) return
        if (accepted > 0) {
          done = true
          // 再等一下下，让 rpcs 计数更接近真实（最多 250 ms）
          setTimeout(() => resolve({ rpcs: accepted + soft }), settled === this.eps.length ? 0 : 250)
        } else if (settled === this.eps.length) {
          done = true
          if (soft > 0) resolve({ rpcs: soft + nonceLow })
          else reject(new Error(errs.join(' | ')))
        }
      }
      for (const ep of this.eps) {
        timed(ep, this.timeout, { method: 'eth_sendRawTransaction', params: [signed] }).then(
          () => {
            accepted++
            settled++
            finish()
          },
          (e) => {
            settled++
            const m = shortErr(e)
            if (/already known|known transaction|already imported/i.test(m)) {
              soft++
              markOk(ep, null)
            } else if (/nonce too low/i.test(m)) {
              nonceLow++
              markOk(ep, null) // 端点是好的，是 nonce 的问题
              errs.push(`${ep.host}: ${m}`)
            } else errs.push(`${ep.host}: ${m}`)
            finish()
          },
        )
      }
    })
  }

  /** 暖机：对每一家打一个便宜的请求；idleMs 内刚用过的跳过 */
  async warm(idleMs = 0) {
    const now = Date.now()
    await Promise.allSettled(
      this.eps.filter((ep) => now - ep.lastOkAt >= idleMs).map((ep) => timed(ep, this.timeout, { method: 'eth_blockNumber' })),
    )
  }
}

/** /health 用：每家 RPC 最近成功／失败 */
export function rpcHealth() {
  const now = Date.now()
  return [...endpoints.values()].map((ep) => ({
    host: ep.host,
    up: ep.consecutiveFails === 0,
    ok: ep.ok,
    fail: ep.fail,
    consecutiveFails: ep.consecutiveFails,
    lastOkAgoMs: ep.lastOkAt ? now - ep.lastOkAt : null,
    lastFailAgoMs: ep.lastFailAt ? now - ep.lastFailAt : null,
    lastErr: ep.lastErr,
    lastMs: ep.lastMs,
  }))
}

/** 从 viem 错误链里挖出 revert data，解成错误名称 */
export function decodeRevert(err, abi) {
  let e = err
  let data = null
  for (let i = 0; i < 10 && e; i++) {
    if (typeof e.data === 'string' && e.data.startsWith('0x')) {
      data = e.data
      break
    }
    if (e.data && typeof e.data.data === 'string') {
      data = e.data.data
      break
    }
    e = e.cause
  }
  if (!data || data === '0x') return { name: null, args: [], data }
  try {
    const d = decodeErrorResult({ abi, data })
    return { name: d.errorName, args: (d.args ?? []).map(String), data }
  } catch {
    return { name: null, args: [], data }
  }
}

export function shortErr(err) {
  return String(err?.shortMessage ?? err?.message ?? err).split('\n')[0].slice(0, 200)
}

/** 本地 nonce：只在启动与遇到 nonce 错误时同步。read＝读取用 viem client，sendPool＝广播用 RpcPool */
export class Signer {
  constructor(account, chainId, readClient, sendPool) {
    this.account = account
    this.chainId = chainId
    this.read = readClient
    this.sendPool = sendPool
    this.nonce = null
    this.queue = Promise.resolve()
  }

  async syncNonce() {
    this.nonce = await this.read.getTransactionCount({ address: this.account.address, blockTag: 'pending' })
  }

  /** 依序送出（同一把钥匙串行，避免 nonce 打架） */
  send(req) {
    const run = this.queue.then(() => this._send(req))
    this.queue = run.catch(() => {})
    return run
  }

  async _send({ to, data, gas, fees }) {
    if (this.nonce === null) await this.syncNonce()
    const f = typeof fees === 'function' ? await fees() : fees
    for (let attempt = 0; ; attempt++) {
      const nonce = this.nonce
      const signed = await this.account.signTransaction({
        chainId: this.chainId,
        type: 'eip1559',
        to,
        data,
        value: 0n,
        gas,
        nonce,
        maxFeePerGas: f.maxFeePerGas,
        maxPriorityFeePerGas: f.maxPriorityFeePerGas,
      })
      const hash = keccak256(signed)
      try {
        const { rpcs } = await this.sendPool.broadcast(signed)
        this.nonce = nonce + 1
        return { hash, rpcs }
      } catch (e) {
        const msg = shortErr(e)
        if (!/nonce/i.test(msg)) throw new Error(`广播失败：${msg}`)
        await this.syncNonce().catch(() => {})
        // nonce 过期：同步后用新 nonce 重签一次（nonce 没变就别重送同一笔）
        if (attempt >= 1 || this.nonce === nonce) throw new Error(`广播失败：${msg}`)
      }
    }
  }
}

/** client 走 RpcPool 时，单家掛掉会自动换家；这里只管轮询到有收据为止 */
export async function waitReceipt(client, hash, timeoutMs = 30_000) {
  const t0 = Date.now()
  for (;;) {
    try {
      const r = await client.getTransactionReceipt({ hash })
      if (r) return r
    } catch {
      /* 还没入块，或这一轮每家都失败 */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`等收据逾时 ${hash}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}
