// Veto / attachReason sender (spec 4.3 steps 3-4).
//  - nonce kept locally: synced (pending count) at start and re-synced after a nonce error / before
//    every veto retry round
//  - gas limit from shared/gas.json (never estimateGas), chainId fixed from the deployments file
//  - fee refreshed in the background every FEE_REFRESH_MS
//  - veto(nextId, ruleHash) pre-signed for every rule while idle
//  - the same raw tx broadcast to every RPC at once: the first with eth_sendRawTransactionSync,
//    the rest with eth_sendRawTransaction; "already known" counts as delivered. "replacement
//    transaction underpriced" is NOT delivered (another tx holds our nonce): it is a nonce error.
//  - no receipt after replaceAfterMs: compare the chain nonce; still unmined -> re-sign the same
//    nonce with a 25% higher fee and broadcast again (at most 3 replacements).
import { encodeFunctionData, keccak256 } from 'viem'
import { RpcError, isRetryable } from './rpc.mjs'
import { sleep } from './util.mjs'

const BENIGN = /already known|known transaction|nonce too low|already imported|transaction already exists/i
const NONCE_ERR = /nonce too (low|high)|invalid nonce|nonce.*(mismatch|gap)|replacement transaction underpriced/i

export class Vetoer {
  constructor({ account, chainId, guardedAdmin, abi, gasLimits, mainRpc, broadcastRpcs, rules, log, feeRefreshMs = 10_000, dryRun = false, receiptTimeoutMs = 30_000, replaceAfterMs = 4_000, maxReplacements = 3 }) {
    Object.assign(this, { account, chainId, guardedAdmin, abi, gasLimits, mainRpc, broadcastRpcs, rules, log, feeRefreshMs, dryRun, receiptTimeoutMs, replaceAfterMs, maxReplacements })
    this.nonce = null
    this.fee = null
    this.feeVersion = 0
    this.presigned = new Map()
    this.lock = Promise.resolve()
    this.syncSupported = true
  }

  async init() {
    // 'pending': a veto still in the pool from before a restart keeps its nonce (no same-nonce clash)
    this.nonce = Number(await this.mainRpc.call('eth_getTransactionCount', [this.account.address, 'pending']))
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

  async sign(functionName, args, nonce, fee = this.fee) {
    const data = encodeFunctionData({ abi: this.abi, functionName, args })
    const gas = this.gasLimits[functionName]
    const raw = await this.account.signTransaction({
      type: 'eip1559',
      chainId: this.chainId,
      nonce,
      to: this.guardedAdmin,
      data,
      gas,
      maxFeePerGas: fee.maxFeePerGas,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
      value: 0n,
    })
    return { raw, hash: keccak256(raw), gas, nonce, fee }
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
      // veto_sent: only now, after the first RPC accepted the raw tx
      onBroadcast?.({ txHash: tx.hash, rpcs: out.rpcs, acceptedBy: out.acceptedBy })
      this.nonce++
      this.presignedKey = null
      setTimeout(() => this.presign(this.nextId).catch(() => {}), 0)
      const ctx = { functionName, args, nonce: tx.nonce, fee: tx.fee }
      return { txHash: tx.hash, rpcs: out.rpcs, acceptedBy: out.acceptedBy, gasLimit: tx.gas, receipt: this.waitReceipt(tx.hash, out.syncReceipt, ctx) }
    })
  }

  async resyncNonce() {
    this.nonce = Number(await this.mainRpc.call('eth_getTransactionCount', [this.account.address, 'pending']))
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
    let acceptedBy = null
    const delivered = await new Promise((resolve) => {
      let pending = attempts.length
      attempts.forEach((p, k) =>
        p.then((r) => {
          settled[k] = { ok: true, label: r.rpc }
          acceptedBy ??= r.rpc
          if (r.receipt) syncReceipt = r.receipt
          resolve(true)
        }).catch((e) => {
          const benign = BENIGN.test(e.message) && !/nonce too low/i.test(e.message) ? true : false
          settled[k] = { ok: benign, label: rpcs[k].label, error: e.message, nonce: NONCE_ERR.test(e.message), transport: isRetryable(e) }
          if (benign) {
            acceptedBy ??= rpcs[k].label
            resolve(true)
          }
        }).finally(() => {
          if (--pending === 0) resolve(settled.some((s) => s?.ok))
        }),
      )
    })
    const errors = settled.filter((s) => s && !s.ok).map((s) => `${s.label}: ${s.error}`)
    // "nonce too low" on every RPC means our local nonce is stale (or another RPC already has it).
    const nonceError = !delivered && settled.filter(Boolean).every((s) => s.nonce)
    const transportOnly = !delivered && settled.filter(Boolean).length > 0 && settled.filter(Boolean).every((s) => s.transport && !s.nonce)
    return { delivered, nonceError, transportOnly, errors, rpcs: rpcs.map((r) => r.label), acceptedBy, syncReceipt: () => syncReceipt }
  }

  // Poll for the receipt of `hash` (or of any replacement of it). Every replaceAfterMs without one,
  // compare the chain nonce: still unmined -> re-sign the same nonce with a higher fee and broadcast
  // it again; the nonce already used by something else -> keep looking a little, then fail.
  async waitReceipt(hash, syncReceipt, ctx = null) {
    const t0 = Date.now()
    const hashes = [hash.toLowerCase()]
    let lastCheck = Date.now()
    let replacements = 0
    let fee = ctx?.fee
    while (Date.now() - t0 < this.receiptTimeoutMs) {
      const s = syncReceipt?.()
      if (s && hashes.includes(s.transactionHash?.toLowerCase())) return s
      for (const h of hashes) {
        try {
          const r = await this.mainRpc.call('eth_getTransactionReceipt', [h])
          if (r) return r
        } catch (e) {
          this.log.warn(`receipt poll: ${e.message}`)
        }
      }
      if (ctx && Date.now() - lastCheck >= this.replaceAfterMs && replacements < this.maxReplacements) {
        lastCheck = Date.now()
        try {
          const mined = Number(await this.mainRpc.call('eth_getTransactionCount', [this.account.address, 'latest']))
          if (mined <= ctx.nonce) {
            fee = { maxFeePerGas: (fee.maxFeePerGas * 125n) / 100n + 1n, maxPriorityFeePerGas: (fee.maxPriorityFeePerGas * 125n) / 100n + 1n }
            const tx = await this.sign(ctx.functionName, ctx.args, ctx.nonce, fee)
            replacements++
            hashes.push(tx.hash.toLowerCase())
            this.log.warn(`no receipt for ${hash} after ${Date.now() - t0} ms (chain nonce ${mined} <= ${ctx.nonce}): re-sent nonce ${ctx.nonce} at +25% fee as ${tx.hash}`)
            const out = await this.broadcast(tx.raw)
            if (!out.delivered) this.log.warn(`replacement broadcast: ${out.errors.join(' | ').slice(0, 200)}`)
          }
        } catch (e) {
          this.log.warn(`replacement check: ${e.message.slice(0, 160)}`)
        }
      }
      await sleep(120)
    }
    throw new Error(`no receipt for ${hashes.join(',')} after ${this.receiptTimeoutMs} ms`)
  }
}

// gas.json shape is owned by the contracts line; accept a plain number or an object with a limit.
// GAS_HEADROOM multiplies the gas.json limits. On anvil --network monad a first veto uses 89,535–100,335
// gas depending on cold SLOADs (four at 8,100 each); the default 1.25 (123,112) covers the largest case
// without estimating.
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
