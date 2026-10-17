// 订阅 3 个哨兵、driver、reporter 的 SSE。每则 data 是一行 JSON（spec 4.4）。
// 同时支援未命名事件（onmessage）与 `event: <type>` 命名事件。
// 连线生命周期见下方：离开页面一律释放，回来重建，出错退避重连、不累积。
import { CONFIG, type ServiceName } from './config'
import { SERVICE_NAMES, svcUrl } from './runtime'
import { store } from './store'
import { EVENT_TYPES, type WarEvent } from './types'

function handle(name: ServiceName, raw: string) {
  let e: WarEvent
  try {
    e = JSON.parse(raw)
  } catch {
    return
  }
  if (!e.source) e.source = name
  store.ingest(e)
}

// ---------- 连线生命周期 ----------
// 5 条 EventSource 都打同一个 host（vite /svc 代理），Chrome HTTP/1.1 每 host 只有 6 条连线。
// 旧页面的连线若没释放，回来时新连线会排队，哨兵看起来离线约 60 秒。所以：
//  · pagehide / beforeunload 一律 close 全部连线；pageshow（含 bfcache 回来）重建
//  · 分页隐藏超过 HIDDEN_CLOSE_MS 才关，回到前景立刻重建
//  · 出错时自己 close，再按退避重连（不让浏览器内建重连与我们的重连叠加、累积连线）
//  · 重连时带 ?backlog=N 补回断线期间的事件；store.ingest 会去重、并丢掉页面载入前的旧事件
const HIDDEN_CLOSE_MS = 20_000
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000]
const RECONNECT_BACKLOG = 50

interface Conn {
  name: ServiceName
  es: EventSource | null
  timer: ReturnType<typeof setTimeout> | null
  retry: number
  /** 连上过一次之后的重连才要积压（第一次连线维持 live-only） */
  everOpened: boolean
}

const conns: Conn[] = []
let active = false
let hiddenTimer: ReturnType<typeof setTimeout> | null = null

function urlFor(c: Conn): string {
  const base = svcUrl(c.name, CONFIG.ssePath)
  return c.everOpened ? `${base}${base.includes('?') ? '&' : '?'}backlog=${RECONNECT_BACKLOG}` : base
}

function markClosed(c: Conn) {
  store.touch(c.name, { sseOpen: false })
  store.emit()
}

function open(c: Conn) {
  if (!active || c.es || c.timer !== null) return
  const es = new EventSource(urlFor(c))
  c.es = es
  es.onopen = () => {
    if (c.es !== es) return
    c.retry = 0
    c.everOpened = true
    store.touch(c.name, { sseOpen: true })
    store.emit()
  }
  es.onerror = () => {
    if (c.es !== es) return
    // 关掉这一条（不让浏览器自己重连），由我们退避后重开，保证同一服务永远最多一条
    es.close()
    c.es = null
    markClosed(c)
    schedule(c)
  }
  const onData = (m: MessageEvent) => {
    if (c.es === es) handle(c.name, m.data)
  }
  es.onmessage = onData
  for (const t of EVENT_TYPES) es.addEventListener(t, onData as EventListener)
}

function schedule(c: Conn) {
  if (!active || c.timer !== null) return
  const base = BACKOFF_MS[Math.min(c.retry, BACKOFF_MS.length - 1)]
  c.retry++
  c.timer = setTimeout(
    () => {
      c.timer = null
      open(c)
    },
    Math.round(base * (0.8 + Math.random() * 0.4)),
  )
}

function closeAll() {
  active = false
  for (const c of conns) {
    if (c.timer !== null) clearTimeout(c.timer)
    c.timer = null
    if (c.es) {
      c.es.close()
      c.es = null
      store.touch(c.name, { sseOpen: false })
    }
  }
  store.emit()
}

function openAll() {
  if (active) return
  active = true
  for (const c of conns) {
    c.retry = 0
    open(c)
  }
}

function clearHiddenTimer() {
  if (hiddenTimer !== null) clearTimeout(hiddenTimer)
  hiddenTimer = null
}

export function connectServices() {
  if (conns.length) return
  for (const name of SERVICE_NAMES) conns.push({ name, es: null, timer: null, retry: 0, everOpened: false })
  openAll()
  // 开发时可在主控台看：window.__elevenSse() → 目前开着的 EventSource 数
  if (import.meta.env?.DEV) (window as unknown as { __elevenSse?: () => number }).__elevenSse = openSseCount

  window.addEventListener('pagehide', () => {
    clearHiddenTimer()
    closeAll()
  })
  window.addEventListener('beforeunload', () => {
    clearHiddenTimer()
    closeAll()
  })
  window.addEventListener('pageshow', () => {
    clearHiddenTimer()
    if (document.visibilityState !== 'hidden') openAll()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      clearHiddenTimer()
      hiddenTimer = setTimeout(() => {
        hiddenTimer = null
        closeAll()
      }, HIDDEN_CLOSE_MS)
    } else {
      clearHiddenTimer()
      openAll()
    }
  })
}

/** 测试/除错用：目前开着的 EventSource 数（每个服务最多一条） */
export function openSseCount(): number {
  return conns.filter((c) => c.es !== null).length
}

export async function postDriver<T = any>(path: string, body: unknown): Promise<T> {
  const r = await fetch(svcUrl('driver', path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
  if (!r.ok || j.error) throw new Error(j.error ?? `HTTP ${r.status}`)
  return j as T
}

export async function getDriver<T = any>(path: string): Promise<T> {
  const r = await fetch(svcUrl('driver', path))
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return (await r.json()) as T
}
