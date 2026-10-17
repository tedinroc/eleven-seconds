// Arena engine Worker. No public hostname (workers_dev = false): the Pages project reaches it through
// a service binding and forwards /api/* unchanged. Every /api/* request goes to the single Arena
// Durable Object; the cron trigger only keeps its alarm loop armed.
export { Arena } from './arena-do.mjs'

const stub = (env) => env.ARENA.get(env.ARENA.idFromName('arena'))

function cors(request, env) {
  const origin = request.headers.get('origin')
  const allowed = String(env.ALLOW_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!origin || !allowed.includes(origin)) return {}
  return { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', vary: 'origin' }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const extra = cors(request, env)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: extra })
    if (!url.pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ ok: false, error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json', ...extra } })
    }
    const res = await stub(env).fetch(request)
    if (!Object.keys(extra).length) return res
    const out = new Response(res.body, res)
    for (const [k, v] of Object.entries(extra)) out.headers.set(k, v)
    return out
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(stub(env).ensureAlarm())
  },
}
