// fetch-based JSON-RPC for the Worker (the sentinel's rpc.mjs uses node:https keep-alive agents,
// which do not exist here). Same error model: transport failures, HTTP 429/5xx and rate-limit
// messages are "retryable" (move to the next provider); JSON-RPC answers such as reverts are not.

const TRANSPORT = /tls|handshake|\beof\b|econnreset|timeout|timed out|network|fetch failed|other side closed|bad gateway|service unavailable|gateway time|internal error/i
const RATE = /rate.?limit|too many requests|limit exceeded|request limit|capacity/i

export class RpcError extends Error {
  constructor(message, { code, data, httpStatus, label } = {}) {
    super(message)
    this.code = code
    this.data = data
    this.httpStatus = httpStatus
    this.label = label
  }
  get retryable() {
    if (this.code === 'TIMEOUT' || this.code === 'NETWORK') return true
    if (this.httpStatus === 429 || this.code === 429 || this.code === -32005) return true
    if (typeof this.httpStatus === 'number' && this.httpStatus !== 200) return true
    if (RATE.test(this.message)) return true
    return (this.code == null || this.code === -32603) && TRANSPORT.test(this.message)
  }
}
export const isRetryable = (e) => (e instanceof RpcError ? e.retryable : TRANSPORT.test(e?.message ?? '') || RATE.test(e?.message ?? ''))

// Host label only: paths and query strings can carry API keys.
export function rpcLabel(url) {
  try {
    const u = new URL(url)
    return u.port ? `${u.hostname}:${u.port}` : u.hostname
  } catch {
    return 'rpc'
  }
}

let seq = 1

export function createRpc(url, { timeoutMs = 4_000 } = {}) {
  const label = rpcLabel(url)
  const stats = { requests: 0, errors: 0, lastMs: null, lastOk: 0, lastFail: 0, lastError: null }
  async function call(method, params = [], { timeoutMs: t = timeoutMs } = {}) {
    const t0 = Date.now()
    stats.requests++
    let res
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: seq++, method, params }),
        signal: AbortSignal.timeout(t),
      })
    } catch (e) {
      stats.errors++
      stats.lastFail = Date.now()
      const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError'
      const err = new RpcError(`${label}: ${timeout ? `timeout after ${t} ms` : e?.message ?? 'network error'}`, { code: timeout ? 'TIMEOUT' : 'NETWORK', label })
      stats.lastError = err.message
      throw err
    }
    stats.lastMs = Date.now() - t0
    let body
    const text = await res.text()
    try {
      body = JSON.parse(text)
    } catch {
      stats.errors++
      stats.lastFail = Date.now()
      const err = new RpcError(`${label}: HTTP ${res.status} non-JSON body ${text.slice(0, 80)}`, { httpStatus: res.status, label })
      stats.lastError = err.message
      throw err
    }
    if (res.status !== 200 && !body?.error) {
      stats.errors++
      stats.lastFail = Date.now()
      const err = new RpcError(`${label}: HTTP ${res.status}`, { httpStatus: res.status, label })
      stats.lastError = err.message
      throw err
    }
    if (body.error) {
      const err = new RpcError(`${label}: ${body.error.message ?? 'rpc error'}`, { code: body.error.code, data: body.error.data, httpStatus: res.status, label })
      if (err.retryable) {
        stats.errors++
        stats.lastFail = Date.now()
        stats.lastError = err.message
      }
      throw err
    }
    stats.lastOk = Date.now()
    return body.result
  }
  return { url, label, call, stats }
}

// Sticky failover: the first healthy provider answers; a retryable failure moves to the next one at
// once (and cools the failed one down for cooldownMs).
export function createFailover(clients, { cooldownMs = 20_000 } = {}) {
  let idx = 0
  const cool = new Map()
  return {
    clients,
    get label() {
      return clients[idx]?.label
    },
    async call(method, params, opts) {
      let lastErr
      const order = [...clients.keys()].map((k) => (idx + k) % clients.length)
      const ready = order.filter((k) => (cool.get(k) ?? 0) < Date.now())
      const tryOrder = ready.length ? [...ready, ...order.filter((k) => !ready.includes(k))] : order
      for (const k of tryOrder) {
        try {
          const r = await clients[k].call(method, params, opts)
          idx = k
          return r
        } catch (e) {
          if (!isRetryable(e)) throw e
          lastErr = e
          cool.set(k, Date.now() + cooldownMs)
        }
      }
      throw lastErr ?? new RpcError('no rpc configured', { code: 'NETWORK' })
    },
  }
}
