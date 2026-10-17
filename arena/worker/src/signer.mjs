// Transaction signer for the Worker: local nonce (Monad's pending count equals latest, so the nonce
// is ours to keep), fixed gas limits (never estimateGas), EIP-1559 fees with a priority floor, and
// the same raw tx broadcast to every BROADCAST_RPC at once (first acceptance wins).
import { encodeFunctionData, keccak256 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const BENIGN = /already known|known transaction|already imported|transaction already exists/i
const NONCE_ERR = /nonce too (low|high)|invalid nonce|nonce.*(mismatch|gap)|replacement transaction underpriced/i

export function accountFromKey(raw, label) {
  if (!raw) throw new Error(`secret ${label} is not set`)
  const pk = raw.trim().startsWith('0x') ? raw.trim() : `0x${raw.trim()}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error(`secret ${label} is not a 32-byte hex private key`)
  return privateKeyToAccount(pk)
}

export class Signer {
  /**
   * @param nonces { get(addr) -> number|null, set(addr, n) } persisted by the Durable Object
   */
  constructor({ account, label, chainId, read, broadcast, nonces }) {
    Object.assign(this, { account, label, chainId, read, broadcast, nonces })
    this.lock = Promise.resolve()
  }

  get address() {
    return this.account.address
  }

  withLock(fn) {
    const run = this.lock.then(fn, fn)
    this.lock = run.catch(() => {})
    return run
  }

  async syncNonce() {
    const n = Number(await this.read.call('eth_getTransactionCount', [this.account.address, 'latest']))
    await this.nonces.set(this.account.address, n)
    return n
  }

  async nextNonce() {
    const n = await this.nonces.get(this.account.address)
    return n == null ? this.syncNonce() : n
  }

  /**
   * Sign and broadcast `to.functionName(args)`.
   * @returns {{ txHash, nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas, acceptedBy, rpcs }}
   */
  send({ to, abi, functionName, args, gas, fee }) {
    return this.withLock(async () => {
      const data = encodeFunctionData({ abi, functionName, args })
      let nonce = await this.nextNonce()
      const sign = (n) =>
        this.account.signTransaction({ type: 'eip1559', chainId: this.chainId, nonce: n, to, data, gas, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas, value: 0n })
      let raw = await sign(nonce)
      let out = await broadcastAll(this.broadcast, raw)
      if (!out.delivered && out.nonceError) {
        nonce = await this.syncNonce()
        raw = await sign(nonce)
        out = await broadcastAll(this.broadcast, raw)
      } else if (!out.delivered && out.transportOnly) {
        out = await broadcastAll(this.broadcast, raw)
      }
      if (!out.delivered) throw new Error(`${this.label} ${functionName}: broadcast failed: ${out.errors.join(' | ').slice(0, 300)}`)
      await this.nonces.set(this.account.address, nonce + 1)
      return { txHash: keccak256(raw), nonce, gasLimit: gas.toString(), maxFeePerGas: fee.maxFeePerGas.toString(), maxPriorityFeePerGas: fee.maxPriorityFeePerGas.toString(), acceptedBy: out.acceptedBy, rpcs: out.rpcs }
    })
  }
}

export async function broadcastAll(clients, raw) {
  const settled = await Promise.allSettled(clients.map((c) => c.call('eth_sendRawTransaction', [raw], { timeoutMs: 5_000 })))
  let acceptedBy = null
  const errors = []
  let nonceErrors = 0
  let transport = 0
  settled.forEach((s, k) => {
    if (s.status === 'fulfilled') acceptedBy ??= clients[k].label
    else {
      const msg = String(s.reason?.message ?? s.reason)
      if (BENIGN.test(msg)) acceptedBy ??= clients[k].label
      else {
        errors.push(msg.slice(0, 160))
        if (NONCE_ERR.test(msg)) nonceErrors++
        else if (s.reason?.retryable) transport++
      }
    }
  })
  const delivered = acceptedBy != null
  return {
    delivered,
    acceptedBy,
    errors,
    rpcs: clients.map((c) => c.label),
    nonceError: !delivered && nonceErrors > 0,
    transportOnly: !delivered && transport === errors.length && errors.length > 0,
  }
}

/** EIP-1559 fee from the latest block: maxFee = 2 x base + tip, tip >= floor. */
export async function currentFee(read, minPriorityWei) {
  const [gasPrice, tip, block] = await Promise.all([
    read.call('eth_gasPrice').then(BigInt),
    read.call('eth_maxPriorityFeePerGas').then(BigInt).catch(() => null),
    read.call('eth_getBlockByNumber', ['latest', false]),
  ])
  const base = block?.baseFeePerGas ? BigInt(block.baseFeePerGas) : gasPrice
  let priority = tip ?? (gasPrice > base ? gasPrice - base : 0n)
  if (priority < minPriorityWei) priority = minPriorityWei
  let maxFee = base * 2n + priority
  if (maxFee < gasPrice) maxFee = gasPrice
  return { maxFeePerGas: maxFee, maxPriorityFeePerGas: priority, at: Date.now() }
}
