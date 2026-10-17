// driver 共用：读 shared/（部署位址、ABI、gas）、在执行期从档案读钥匙、本地 nonce、签名与多路广播。
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, decodeErrorResult, http, keccak256, parseAbi } from 'viem'
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
export function makeClient(url) {
  // 一个端点一个 client，全程重用（Node fetch 预设 keep-alive）
  // cacheTime 0：viem 预设会把 getBlockNumber 快取 4 秒，自动 execute 会因此晚好几块
  return createPublicClient({ transport: http(url, { timeout: 6_000, retryCount: 0, batch: false }), cacheTime: 0, pollingInterval: 250 })
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

/** 本地 nonce：只在启动与遇到 nonce 错误时同步 */
export class Signer {
  constructor(account, chainId, readClient, sendClients) {
    this.account = account
    this.chainId = chainId
    this.read = readClient
    this.sends = sendClients
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
    const nonce = this.nonce
    const signed = await this.account.signTransaction({
      chainId: this.chainId,
      type: 'eip1559',
      to,
      data,
      value: 0n,
      gas,
      nonce,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    })
    const hash = keccak256(signed)
    const results = await Promise.allSettled(this.sends.map((c) => c.request({ method: 'eth_sendRawTransaction', params: [signed] })))
    const okCount = results.filter(
      (r) => r.status === 'fulfilled' || /already known|nonce too low|known transaction/i.test(shortErr(r.reason)),
    ).length
    if (okCount === 0) {
      const msg = results.map((r) => shortErr(r.reason)).join(' | ')
      if (/nonce/i.test(msg)) await this.syncNonce().catch(() => {})
      throw new Error(`广播失败：${msg}`)
    }
    this.nonce = nonce + 1
    return { hash, rpcs: okCount }
  }
}

export async function waitReceipt(client, hash, timeoutMs = 20_000) {
  const t0 = Date.now()
  for (;;) {
    try {
      const r = await client.getTransactionReceipt({ hash })
      if (r) return r
    } catch {
      /* 还没入块 */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`等收据逾时 ${hash}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}
