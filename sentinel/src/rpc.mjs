// Minimal JSON-RPC client with persistent keep-alive sockets (spec: new HTTPS connections cost
// 1.3-1.7 s at the venue, kept-alive requests ~320 ms, so every endpoint gets one long-lived agent
// that is created once and reused for the life of the process).
import http from 'node:http'
import https from 'node:https'
import { rpcLabel } from './util.mjs'

export class RpcError extends Error {
  constructor(message, { code, data, httpStatus, label } = {}) {
    super(message)
    this.code = code
    this.data = data
    this.httpStatus = httpStatus
    this.label = label
  }
  // Transport-level failures that justify switching to the other simulation provider (spec 4.2.2).
  get retryable() {
    return this.code === 'TIMEOUT' || this.code === 'NETWORK' || this.httpStatus === 429 || this.code === 429 ||
      (typeof this.httpStatus === 'number' && this.httpStatus >= 500) || /rate|limit|too many/i.test(this.message)
  }
}

let seq = 1

export function createRpc(url, { timeoutMs = 4_000 } = {}) {
  const u = new URL(url)
  const mod = u.protocol === 'https:' ? https : http
  const agent = new mod.Agent({ keepAlive: true, keepAliveMsecs: 10_000, maxSockets: 8, maxFreeSockets: 4 })
  const label = rpcLabel(url)

  function post(body, ms) {
    return new Promise((resolve, reject) => {
      const payload = Buffer.from(body)
      const req = mod.request(
        url,
        { method: 'POST', agent, headers: { 'content-type': 'application/json', 'content-length': payload.length } },
        (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            if (res.statusCode !== 200) {
              return reject(new RpcError(`HTTP ${res.statusCode} ${text.slice(0, 200)}`, { httpStatus: res.statusCode, label }))
            }
            try {
              resolve(JSON.parse(text))
            } catch {
              reject(new RpcError(`bad JSON from ${label}`, { code: 'NETWORK', label }))
            }
          })
          res.on('error', (e) => reject(new RpcError(e.message, { code: 'NETWORK', label })))
        },
      )
      req.setTimeout(ms, () => req.destroy(new RpcError(`timeout after ${ms} ms`, { code: 'TIMEOUT', label })))
      req.on('error', (e) => reject(e instanceof RpcError ? e : new RpcError(e.message, { code: 'NETWORK', label })))
      req.end(payload)
    })
  }

  async function call(method, params = [], { timeoutMs: ms = timeoutMs } = {}) {
    const id = seq++
    const res = await post(JSON.stringify({ jsonrpc: '2.0', id, method, params }), ms)
    if (res.error) {
      throw new RpcError(res.error.message ?? 'rpc error', { code: res.error.code, data: res.error.data, label })
    }
    return res.result
  }

  return { url, label, call, close: () => agent.destroy() }
}
