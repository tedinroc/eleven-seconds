export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// JSON with bigint -> decimal string.
export const toJson = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))

export function makeLogger(source) {
  const fmt = (lvl, args) => `${new Date().toISOString()} ${source} ${lvl} ${args.map((a) => (typeof a === 'string' ? a : toJson(a))).join(' ')}`
  return {
    info: (...a) => console.log(fmt('info', a)),
    warn: (...a) => console.warn(fmt('warn', a)),
    error: (...a) => console.error(fmt('error', a)),
  }
}

// Host label for an RPC URL: never print paths or query strings (they can carry API keys).
export function rpcLabel(url) {
  try {
    const u = new URL(url)
    return u.port ? `${u.hostname}:${u.port}` : u.hostname
  } catch {
    return 'rpc'
  }
}

export const csv = (s) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean)

// Retry a startup call through transient network errors (TLS resets etc.).
export async function retry(fn, { tries = 10, delayMs = 500, log, what = "call" } = {}) {
  for (let k = 1; ; k++) {
    try {
      return await fn()
    } catch (e) {
      if (k >= tries) throw e
      log?.warn?.(`${what} failed (${e.message.slice(0, 120)}), retry ${k}/${tries - 1}`)
      await sleep(Math.min(delayMs * k, 3_000))
    }
  }
}
