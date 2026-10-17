// 订阅 3 个哨兵、driver、reporter 的 SSE。每则 data 是一行 JSON（spec 4.4）。
// 同时支援未命名事件（onmessage）与 `event: <type>` 命名事件。
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

export function connectServices() {
  for (const name of SERVICE_NAMES) {
    const es = new EventSource(svcUrl(name, CONFIG.ssePath))
    es.onopen = () => {
      store.touch(name, { sseOpen: true })
      store.emit()
    }
    es.onerror = () => {
      store.touch(name, { sseOpen: false })
      store.emit()
      // EventSource 会自己重连
    }
    es.onmessage = (m) => handle(name, m.data)
    for (const t of EVENT_TYPES) es.addEventListener(t, (m) => handle(name, (m as MessageEvent).data))
  }
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
