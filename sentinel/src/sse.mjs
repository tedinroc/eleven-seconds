// Local SSE + control server (spec 4.1): GET /events, GET /health, POST /attach.
// Binds to 127.0.0.1 only. Every event is one JSON line with the common fields of spec 4.4.
import http from 'node:http'
import { toJson } from './util.mjs'

export function createEventServer({ port, host = '127.0.0.1', source, mode, health, onAttach, routes = {}, backlogSize = 200, log }) {
  const clients = new Set()
  const backlog = []

  function emit(type, fields = {}) {
    const ev = { v: 1, type, ts: Date.now(), mode, source, ...fields }
    const line = toJson(ev)
    backlog.push(line)
    if (backlog.length > backlogSize) backlog.shift()
    for (const res of clients) res.write(`data: ${line}\n\n`)
    return ev
  }

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
  }
  const sendJson = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', ...cors })
    res.end(toJson(body))
  }
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let buf = ''
      req.on('data', (c) => {
        buf += c
        if (buf.length > 64_000) reject(new Error('body too large'))
      })
      req.on('end', () => {
        try {
          resolve(buf ? JSON.parse(buf) : {})
        } catch (e) {
          reject(e)
        }
      })
      req.on('error', reject)
    })

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      return res.end()
    }
    try {
      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...cors })
        res.write(': connected\n\n')
        // Opt-in backlog (?backlog=N) for late subscribers such as the reporter; default is live-only.
        const n = Math.min(Number(url.searchParams.get('backlog') ?? 0) || 0, backlog.length)
        for (const line of backlog.slice(backlog.length - n)) res.write(`data: ${line}\n\n`)
        clients.add(res)
        req.on('close', () => clients.delete(res))
        return
      }
      if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, health ? health() : { ok: true, source })
      if (req.method === 'POST' && url.pathname === '/attach') {
        if (!onAttach) return sendJson(res, 404, { ok: false, error: 'attach not enabled on this sentinel' })
        const body = await readBody(req)
        const out = await onAttach(body)
        return sendJson(res, out.ok ? 200 : 400, out)
      }
      const key = `${req.method} ${url.pathname}`
      if (routes[key]) {
        const body = req.method === 'POST' ? await readBody(req) : Object.fromEntries(url.searchParams)
        return sendJson(res, 200, await routes[key](body))
      }
      sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (e) {
      log?.warn?.(`http ${req.method} ${url.pathname}: ${e.message}`)
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: e.message })
    }
  })

  // Comment ping keeps proxies and EventSource from timing out idle streams.
  const ping = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n')
  }, 15_000)

  return {
    emit,
    clients,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => resolve())
    }),
    close: () => {
      clearInterval(ping)
      for (const res of clients) res.end()
      clients.clear()
      return new Promise((r) => server.close(() => r()))
    },
    // Drop all subscribers (used by the fake generator to simulate a crashed sentinel).
    dropClients: () => {
      for (const res of clients) res.destroy()
      clients.clear()
    },
  }
}
