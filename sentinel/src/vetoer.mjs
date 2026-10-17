// Veto / attachReason sender (spec 4.3 steps 3-4).
//  - nonce kept locally: synced at start and only re-synced after a nonce error
//  - gas limit from shared/gas.json (never estimateGas), chainId fixed from the deployments file
//  - fee refreshed in the background every FEE_REFRESH_MS
//  - veto(nextId, ruleHash) pre-signed for every rule while idle
//  - the same raw tx broadcast to every RPC at once: the first with eth_sendRawTransactionSync,
//    the rest with eth_sendRawTransaction; "already known" / "nonce too low" count as delivered.
import { encodeFunctionData, keccak256 } from 'viem'
import { RpcError, isRetryable } from './rpc.mjs'
import { sleep } from './util.mjs'

const BENIGN = /already known|known transaction|nonce too low|already imported|replacement transaction underpriced|transaction already exists/i
const NONCE_ERR = /nonce too (low|high)|invalid nonce|nonce.*(mismatch|gap)/i

export class Vetoer {
  constructor({ account, chainId, guardedAdmin, abi, gasLimits, mainRpc, broadcastRpcs, rules, log, feeRefreshMs = 10_000, dryRun = false, receiptTimeoutMs = 30_000 }) {
    Object.assign(this, { account, chainId, guardedAdmin, abi, gasLimits, mainRpc, broadcastRpcs, rules, log, feeRefreshMs, dryRun, receiptTimeoutMs })
    this.nonce = null
    this.fee = null
    this.feeVersion = 0
    this.presigned = new Map()
    this.lock = Promise.resolve()
    this.syncSupported = true
  }

  async init() {
    this.nonce = Number(await this.mainRpc.call('eth_getTransactionCount', [this.account.address, 'latest']))
    await this.refreshFee()
    clearInterval(this.feeTimer)
    this.feeTimer = setInterval(() => this.refreshFee().then(() => this.presign(this.nextId)).catch((e) => this.log.warn(`fee refresh: ${e.message}`)), this.feeRefreshMs)
    this.log.info(`signer ${this.account.address} nonce=${this.nonce} chainId=${this.chainId}${this.dryRun ? ' DRY_RUN (no broadcast)' : ''}`)
  }

  stop() {
    clearInterval(this.feeTimer)
  }

  async refreshFee() {
    const [gasPrice, tip, block] = await Promise.all([
      this.mainRpc.call('eth_gasPrice').then(BigInt),
      this.mainRpc.call('eth_maxPriorityFeePerGas').then(BigInt).catch(() => null),
      this.mainRpc.call('eth_getBlockByNumber', ['latest', false]),
    ])
    const base = block?.baseFeePerGas ? BigInt(block.baseFeePerGas) : gasPrice
    // Floor the tip so a veto is not queued behind cheaper traffic (VETO_MIN_PRIORITY_GWEI, default 10).
    const minTip = BigInt(Math.round(Number(process.env.VETO_MIN_PRIORITY_GWEI ?? '10') * 1e9))
    let priority = tip ?? (gasPrice > base ? gasPrice - base : 0n)
    if (priority < minTip) priority = minTip
    let maxFee = base * 2n + priority
    if (maxFee < gasPrice) maxFee = gasPrice
    const changed = !this.fee || this.fee.maxFeePerGas !== maxFee || this.fee.maxPriorityFeePerGas !== priority
    this.fee = { maxFeePerGas: maxFee, maxPriorityFeePerGas: priority }
    if (changed) this.feeVersion++
  }

  // Serialize everything that consumes a nonce.
  withLock(fn) {
    const run = this.lock.then(fn, fn)
    this.lock = run.catch(() => {})
    return run
  }

  async sign(functionName, args, nonce) {
    const data = encodeFunctionData({ abi: this.abi, functionName, args })
    const gas = this.gasLimits[functionName]
    const raw = await this.account.signTransaction({
      type: 'eip1559',
      chainId: this.chainId,
      nonce,
      to: this.guardedAdmin,
      data,
      gas,
      maxFeePerGas: this.fee.maxFeePerGas,
      maxPriorityFeePerGas: this.fee.maxPriorityFeePerGas,
      value: 0n,
    })
    return { raw, hash: keccak256(raw), gas }
  }

  // Pre-sign veto(nextId, ruleHash) for every rule at the current nonce and fee.
  async presign(nextId) {
    if (nextId == null || this.nonce == null || !this.fee) return
    this.nextId = nextId
    const key = `${this.nonce}:${nextId}:${this.feeVersion}`
    if (this.presignedKey === key) return
    const map = new Map()
    for (const r of Object.values(this.rules)) {
      map.set(r.hash, await this.sign('veto', [BigInt(nextId), r.hash], this.nonce))
    }
    this.presigned = map
    this.presignedKey = key
  }

  /** Send a guardian tx. Resolves once broadcast; `.receipt` resolves with the receipt. */
  send(functionName, args, { onBroadcast } = {}) {
    return this.withLock(async () => {
      let tx
      const id = Number(args[0])
      if (functionName === 'veto' && this.presignedKey === `${this.nonce}:${id}:${this.feeVersion}` && this.presigned.has(args[1])) {
        tx = this.presigned.get(args[1])
      } else {
        tx = await this.sign(functionName, args, this.nonce)
      }
      if (this.dryRun) return { txHash: tx.hash, rpcs: [], dryRun: true, receipt: Promise.resolve(null) }
      onBroadcast?.({ txHash: tx.hash, rpcs: this.broadcastRpcs.map((r) => r.label) })
      let out = await this.broadcast(tx.raw)
      if (!out.delivered && out.transportOnly) {
        // Every RPC failed on the transport (tls eof, reset, 429...): resend the same raw tx once
        // right away; the sockets that failed are gone, so this goes out on fresh connections.
        this.log.warn(`broadcast: all RPCs failed on transport (${out.errors.join(' | ').slice(0, 200)}), resending once`)
        out = await this.broadcast(tx.raw)
      }
      if (!out.delivered && out.nonceError) {
        await this.resyncNonce()
        tx = await this.sign(functionName, args, this.nonce)
        out = await this.broadcast(tx.raw)
      }
      if (!out.delivered) throw new Error(`broadcast failed on all RPCs: ${out.errors.join(' | ')}`)
      this.nonce++
      this.presignedKey = null
      setTimeout(() => this.presign(this.nextId).catch(() => {}), 0)
      return { txHash: tx.hash, rpcs: out.rpcs, gasLimit: tx.gas, receipt: this.waitReceipt(tx.hash, out.syncReceipt) }
    })
  }

  async resyncNonce() {
    this.nonce = Number(await this.mainRpc.call('eth_getTransactionCount', [this.account.address, 'latest']))
    this.presignedKey = null
    this.log.warn(`nonce resynced to ${this.nonce}`)
  }

  async broadcast(raw) {
    const rpcs = this.broadcastRpcs
    const attempts = rpcs.map(async (rpc, k) => {
      if (k === 0 && this.syncSupported) {
        try {
          const receipt = await rpc.call('eth_sendRawTransactionSync', [raw], { timeoutMs: 10_000 })
          return { rpc: rpc.label, receipt }
        } catch (e) {
          if (e instanceof RpcError && (e.code === -32601 || /not (found|supported|available)|unknown method/i.test(e.message))) {
            this.syncSupported = false
            this.log.warn(`${rpc.label}: eth_sendRawTransactionSync unsupported, using eth_sendRawTransaction`)
          } else throw e
        }
      }
      await rpc.call('eth_sendRawTransaction', [raw], { timeoutMs: 5_000 })
      return { rpc: rpc.label }
    })
    // Resolve as soon as any RPC accepts the tx; collect all outcomes for the event.
    const settled = []
    let syncReceipt = null
    const delivered = await new Promise((resolve) => {
      let pending = attempts.length
      attempts.forEach((p, k) =>
        p.then((r) => {
          settled[k] = { ok: true, label: r.rpc }
          if (r.receipt) syncReceipt = r.receipt
          resolve(true)
        }).catch((e) => {
          const benign = BENIGN.test(e.message) && !/nonce too low/i.test(e.message) ? true : false
          settled[k] = { ok: benign, label: rpcs[k].label, error: e.message, nonce: NONCE_ERR.test(e.message), transport: isRetryable(e) }
          if (benign) resolve(true)
        }).finally(() => {
          if (--pending === 0) resolve(settled.some((s) => s?.ok))
        }),
      )
    })
    const errors = settled.filter((s) => s && !s.ok).map((s) => `${s.label}: ${s.error}`)
    // "nonce too low" on every RPC means our local nonce is stale (or another RPC already has it).
    const nonceError = !delivered && settled.filter(Boolean).every((s) => s.nonce)
    const transportOnly = !delivered && settled.filter(Boolean).length > 0 && settled.filter(Boolean).every((s) => s.transport && !s.nonce)
    return { delivered, nonceError, transportOnly, errors, rpcs: rpcs.map((r) => r.label), syncReceipt: () => syncReceipt }
  }

  async waitReceipt(hash, syncReceipt) {
    const t0 = Date.now()
    while (Date.now() - t0 < this.receiptTimeoutMs) {
      const s = syncReceipt?.()
      if (s && s.transactionHash?.toLowerCase() === hash.toLowerCase()) return s
      try {
        const r = await this.mainRpc.call('eth_getTransactionReceipt', [hash])
        if (r) return r
      } catch (e) {
        this.log.warn(`receipt poll: ${e.message}`)
      }
      await sleep(120)
    }
    throw new Error(`no receipt for ${hash} after ${this.receiptTimeoutMs} ms`)
  }
}

// gas.json shape is owned by the contracts line; accept a plain number or an object with a limit.
// GAS_HEADROOM multiplies the gas.json limits. Observed on anvil --network monad: a first veto used
// 89,535 gas early in a run and 100,335 later (four cold SLOADs at 8,100 each), above gas.json's
// 98,489 (= 89,535 x 1.10), so a 1.10 margin was too tight. Default 1.25 keeps a margin without estimating.
export function readGasLimits(gasJson, log, headroom = Number(process.env.GAS_HEADROOM ?? 1.25)) {
  const defaults = { veto: 200_000n, attachReason: 120_000n }
  const out = {}
  const src = gasJson?.gas ?? gasJson?.functions ?? gasJson ?? {}
  for (const fn of Object.keys(defaults)) {
    const v = src[fn]
    const n = typeof v === 'number' || typeof v === 'string' ? v : v?.gasLimit ?? v?.limit ?? v?.suggestedGasLimit ?? v?.suggested ?? v?.gas
    if (n != null && Number(n) > 0) out[fn] = BigInt(Math.ceil(Number(n) * headroom))
    else {
      out[fn] = defaults[fn]
      log?.warn?.(`gas.json has no limit for ${fn}; using fallback ${defaults[fn]}`)
    }
  }
  return out
}
