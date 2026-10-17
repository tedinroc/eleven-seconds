// Minimal JSON-RPC client with persistent keep-alive sockets. Measured at the venue: a new HTTPS
// connection costs 1.3-1.7 s (and sometimes dies with "tls handshake eof"), a kept-alive request
// ~320 ms. So every endpoint gets exactly one client (one http(s).Agent with keepAlive) that is
// created once and reused for the life of the process (`clientFor`), and on top of that:
//   - createFailover: a sticky client over several endpoints that switches to the next one at once
//     on a transport error (tls eof, ECONNRESET, timeout, HTTP 429/5xx, "request failed", ...).
//   - raceRpc: the same read sent to several warm endpoints, first good answer wins.
//   - keepWarm: an eth_chainId ping on every idle client so its socket never goes cold.
// No fetch/undici here: node:http(s) with an explicit keepAlive Agent, so socket reuse is visible
// (`stats.reused` / `req.reusedSocket`) and testable.
import http from 'node:http'
import https from 'node:https'
import { rpcLabel } from './util.mjs'

const TRANSPORT = /tls|handshake|\beof\b|econnreset|econnrefused|etimedout|enotfound|eai_again|epipe|socket hang up|request failed|network|timeout|other side closed|bad gateway|service unavailable|gateway time/i
const RATE = /rate.?limit|too many requests|limit exceeded|request limit|capacity/i

export class RpcError extends Error {
  constructor(message, { code, data, httpStatus, label, reused } = {}) {
    super(message)
    this.code = code
    this.data = data
    this.httpStatus = httpStatus
    this.label = label
    this.reused = reused
  }
  // Transport-level failures (or rate limits) that justify switching to the next provider at once.
  // JSON-RPC answers such as "execution reverted" are real answers and never retryable.
  get retryable() {
    if (this.code === 'TIMEOUT' || this.code === 'NETWORK') return true
    if (this.httpStatus === 429 || this.code === 429 || this.code === -32005) return true
    if (typeof this.httpStatus === 'number' && this.httpStatus !== 200) return true // 429, 5xx, 403 from a gateway
    if (RATE.test(this.message)) return true
    return (this.code == null || this.code === -32603) && TRANSPORT.test(this.message)
  }
}

export const isRetryable = (e) => (e instanceof RpcError ? e.retryable : TRANSPORT.test(e?.message ?? '') || RATE.test(e?.message ?? ''))

let seq = 1

export function createRpc(url, { timeoutMs = 4_000, maxSockets = 8 } = {}) {
  const u = new URL(url)
  const mod = u.protocol === 'https:' ? https : http
  // keepAlive: reuse sockets between requests; lifo: always take the most recently used (warmest)
  // socket so one socket stays hot instead of several going lukewarm.
  const agent = new mod.Agent({ keepAlive: true, keepAliveMsecs: 10_000, maxSockets, maxFreeSockets: 4, scheduling: 'lifo' })
  const label = rpcLabel(url)
  const stats = { requests: 0, reused: 0, fresh: 0, errors: 0, inFlight: 0, lastActivity: 0, lastMs: null, lastReused: null, lastOk: 0, lastFail: 0 }
  let pinging = null

  function post(body, ms) {
    return new Promise((resolve, reject) => {
      const payload = Buffer.from(body)
      const t0 = Date.now()
      stats.requests++
      stats.inFlight++
      stats.lastActivity = t0
      let done = false
      const finish = (fn, v) => {
        if (done) return
        done = true
        stats.inFlight--
        stats.lastActivity = Date.now()
        stats.lastMs = Date.now() - t0
        if (fn === resolve) stats.lastOk = Date.now()
        else if (isRetryable(v)) stats.lastFail = Date.now()
        fn(v)
      }
      const req = mod.request(
        url,
        { method: 'POST', agent, headers: { 'content-type': 'application/json', 'content-length': payload.length } },
        (res) => {
          const reused = !!req.reusedSocket
          stats.lastReused = reused
          if (reused) stats.reused++
          else stats.fresh++
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            if (res.statusCode !== 200) {
              stats.errors++
              return finish(reject, new RpcError(`HTTP ${res.statusCode} ${text.slice(0, 200)}`, { httpStatus: res.statusCode, label, reused }))
            }
            try {
              finish(resolve, JSON.parse(text))
            } catch {
              stats.errors++
              finish(reject, new RpcError(`bad JSON from ${label}`, { code: 'NETWORK', label, reused }))
            }
          })
          res.on('error', (e) => {
            stats.errors++
            finish(reject, new RpcError(e.message, { code: 'NETWORK', label, reused }))
          })
        },
      )
      req.setTimeout(ms, () => req.destroy(new RpcError(`timeout after ${ms} ms`, { code: 'TIMEOUT', label })))
      req.on('error', (e) => {
        stats.errors++
        // A kept-alive socket the server closed while idle fails with ECONNRESET / socket hang up
        // on reuse: still a transport error, the failover layer moves on to the next provider.
        finish(reject, e instanceof RpcError ? e : new RpcError(`${e.code ? e.code + ' ' : ''}${e.message}`, { code: 'NETWORK', label, reused: !!req.reusedSocket }))
      })
      req.end(payload)
    })
  }

  async function call(method, params = [], { timeoutMs: ms = timeoutMs, waitPingMs = 0 } = {}) {
    // A latency-critical call that would otherwise open a new (cold, 1.3-1.7 s) connection because
    // the keep-warm ping holds the only warm socket waits for the ping (~320 ms) instead.
    if (waitPingMs > 0 && pinging) await Promise.race([pinging, new Promise((r) => setTimeout(r, waitPingMs))])
    const id = seq++
    const res = await post(JSON.stringify({ jsonrpc: '2.0', id, method, params }), ms)
    if (res.error) {
      throw new RpcError(res.error.message ?? 'rpc error', { code: res.error.code, data: res.error.data, label })
    }
    return res.result
  }

  // Keep-warm ping: skipped while the client is busy or was used recently.
  function ping(idleMs = 0) {
    if (pinging || stats.inFlight > 0 || Date.now() - stats.lastActivity < idleMs) return pinging ?? Promise.resolve()
    pinging = call('eth_chainId', [], { timeoutMs: Math.min(timeoutMs, 5_000) })
      .catch(() => {})
      .finally(() => (pinging = null))
    return pinging
  }

  return { url, label, call, ping, stats, close: () => agent.destroy() }
}

// A client whose latest outcome (including a keep-warm ping) was a transport failure within
// `windowMs`: callers with a choice try the other provider first instead of paying for it again.
export const suspect = (c, windowMs = 30_000) => c.stats.lastFail > c.stats.lastOk && Date.now() - c.stats.lastFail < windowMs

// One client per URL for the whole process, so polling, reads, simulation and broadcast that hit the
// same provider share its warm socket instead of each paying a TLS handshake.
const registry = new Map()
export function clientFor(url, opts) {
  if (!registry.has(url)) registry.set(url, createRpc(url, opts))
  return registry.get(url)
}
export const allClients = () => [...registry.values()]

/**
 * Sticky failover over several clients: calls go to the active one; on a retryable (transport /
 * rate-limit) error the same call is retried immediately on the next client, which becomes active.
 * After `recheckMs` on a fallback the primary is tried first again.
 */
export function createFailover(clients, { log, name = 'rpc', recheckMs = 60_000 } = {}) {
  if (!clients.length) throw new Error(`${name}: no RPC endpoints`)
  let active = 0
  let switchedAt = 0
  const switches = []
  async function call(method, params = [], opts = {}) {
    if (active !== 0 && Date.now() - switchedAt > recheckMs) active = 0
    let lastErr
    const start = active
    for (let k = 0; k < clients.length; k++) {
      const idx = (start + k) % clients.length
      const c = clients[idx]
      try {
        const r = await c.call(method, params, opts)
        if (idx !== active) {
          log?.warn?.(`${name}: ${clients[active].label} -> ${c.label} (${lastErr?.message?.slice(0, 80) ?? 'recovered'})`)
          switches.push({ at: Date.now(), from: clients[active].label, to: c.label })
          if (switches.length > 20) switches.shift()
          active = idx
          switchedAt = Date.now()
        }
        return r
      } catch (e) {
        lastErr = e
        if (!isRetryable(e)) throw e
      }
    }
    throw lastErr
  }
  return {
    get url() { return clients[active].url },
    get label() { return clients[active].label },
    clients,
    switches,
    call,
    close: () => clients.forEach((c) => c.close()),
  }
}

/** Send the same read to every client at once; resolve with the first success ({ result, label }). */
export function raceRpc(clients, method, params = [], opts = {}) {
  const uniq = [...new Set(clients)]
  return Promise.any(uniq.map((c) => c.call(method, params, opts).then((result) => ({ result, label: c.label })))).catch((e) => {
    throw e instanceof AggregateError ? e.errors[0] : e
  })
}

/** Ping every client that has been idle for `intervalMs` (eth_chainId), checking every second. */
export function keepWarm(clients, intervalMs) {
  if (!(intervalMs > 0)) return null
  const uniq = [...new Set(clients)]
  const timer = setInterval(() => uniq.forEach((c) => c.ping(intervalMs)), Math.min(1_000, intervalMs))
  timer.unref?.()
  return timer
}
