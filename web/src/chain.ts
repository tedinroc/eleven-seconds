// 区块流：浏览器直接 WS 订阅 monadNewHeads（测试网，带 commitState）或 newHeads（anvil）；
// WS 断线就退回 300ms 轮询 eth_blockNumber，同时在背景重连 WS。全程重用同一条 WS / keep-alive。

import { CONFIG } from './config'
import { CHAIN, HAS_COMMIT_STATE } from './runtime'

/** 四段状态：0 Proposed、1 Voted、2 Finalized、3 Verified */
export const STAGES = ['Proposed', 'Voted', 'Finalized', 'Verified'] as const
export const STAGE_CN = ['提议', '投票', '终局', '已验证'] as const

export type Link = 'ws' | 'poll' | 'down' | 'fake'

export class BlockStream {
  latest = 0
  link: Link = 'down'
  linkUrl = ''
  private seen = new Map<number, number>() // block -> 已见过的最高阶段（只记 Proposed/Voted）
  maxFinalized = 0
  maxVerified = 0
  private arrivals: { n: number; t: number }[] = []
  private listeners = new Set<() => void>()
  private ws: WebSocket | null = null
  private wsIdx = 0
  private pollTimer: number | null = null
  private pollTick = 0
  private stopped = false

  onChange(fn: () => void) {
    this.listeners.add(fn)
  }

  private emit() {
    for (const fn of this.listeners) fn()
  }

  /** 收一个区块头（WS、轮询或假事件播放器都走这里） */
  ingest(n: number, commitState: string | null) {
    if (!Number.isFinite(n) || n <= 0) return
    let changed = false
    const stage = commitState ? STAGES.indexOf(commitState as (typeof STAGES)[number]) : 0
    if (stage === 0 || !HAS_COMMIT_STATE) {
      if (n > this.latest) {
        this.latest = n
        this.arrivals.push({ n, t: performance.now() })
        if (this.arrivals.length > CONFIG.blockTimeWindow) this.arrivals.shift()
        changed = true
      }
    }
    if (stage === 2 && n > this.maxFinalized) {
      this.maxFinalized = n
      changed = true
    } else if (stage === 3 && n > this.maxVerified) {
      this.maxVerified = n
      changed = true
    } else if (stage === 0 || stage === 1) {
      const prev = this.seen.get(n) ?? -1
      if (stage > prev) {
        this.seen.set(n, stage)
        changed = true
      }
      if (this.seen.size > 2000) {
        const cut = this.latest - 1000
        for (const k of this.seen.keys()) if (k < cut) this.seen.delete(k)
      }
    }
    if (changed) this.emit()
  }

  /** 某块目前到达的阶段；-1 表示还没看到 */
  stageOf(n: number | null | undefined): number {
    if (!n) return -1
    if (this.maxVerified >= n) return 3
    if (this.maxFinalized >= n) return 2
    const s = this.seen.get(n)
    if (s !== undefined) return s
    return this.latest >= n ? 0 : -1
  }

  /** 实测平均出块时间（毫秒，按到达时间）；样本不足回 null */
  blockTimeMs(): number | null {
    const a = this.arrivals
    if (a.length < 6) return null
    const first = a[0]
    const last = a[a.length - 1]
    const dn = last.n - first.n
    if (dn <= 0) return null
    return (last.t - first.t) / dn
  }

  /** blockTimeMs 用了几块的样本 */
  sampleBlocks(): number {
    const a = this.arrivals
    return a.length < 2 ? 0 : a[a.length - 1].n - a[0].n
  }

  start() {
    this.openWs()
  }

  stop() {
    this.stopped = true
    this.ws?.close()
    this.stopPoll()
  }

  setFake() {
    this.link = 'fake'
    this.linkUrl = '内建假事件播放器'
    this.emit()
  }

  private openWs() {
    if (this.stopped || CHAIN.ws.length === 0) {
      this.startPoll()
      return
    }
    const url = CHAIN.ws[this.wsIdx % CHAIN.ws.length]
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch {
      this.wsFailed()
      return
    }
    this.ws = ws
    ws.onopen = () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: [CHAIN.headsMethod] }))
    }
    ws.onmessage = (ev) => {
      let msg: any
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (msg.id === 1 && msg.result) {
        this.link = 'ws'
        this.linkUrl = url
        this.stopPoll()
        this.emit()
        return
      }
      if (msg.id === 1 && msg.error) {
        ws.close()
        return
      }
      const h = msg?.params?.result
      if (!h) return
      const n = parseInt(h.number ?? h.blockNumber, 16)
      this.ingest(n, typeof h.commitState === 'string' ? h.commitState : null)
    }
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null
      this.wsFailed()
    }
    ws.onerror = () => {
      /* onclose 会接着触发 */
    }
  }

  private wsFailed() {
    if (this.stopped) return
    this.wsIdx++
    this.startPoll()
    setTimeout(() => this.openWs(), 2000)
  }

  private startPoll() {
    if (this.pollTimer !== null) return
    this.link = 'poll'
    this.emit()
    this.pollTimer = window.setInterval(() => void this.pollOnce(), CONFIG.pollMs)
  }

  private stopPoll() {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private httpIdx = 0
  private async pollOnce() {
    const url = CHAIN.http[this.httpIdx % CHAIN.http.length]
    this.pollTick++
    try {
      const n = await rpc<string>(url, 'eth_blockNumber', [])
      this.linkUrl = url
      this.ingest(parseInt(n, 16), null)
      // 轮询模式拿不到 commitState，每 4 次补问一次 finalized 标签
      if (HAS_COMMIT_STATE && this.pollTick % 4 === 0) {
        const b = await rpc<{ number: string } | null>(url, 'eth_getBlockByNumber', ['finalized', false])
        if (b?.number) this.ingest(parseInt(b.number, 16), 'Finalized')
      }
    } catch {
      this.httpIdx++
      if (this.link !== 'ws') {
        this.link = 'down'
        this.emit()
      }
    }
  }
}

let rpcId = 100
export async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 3000)
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
      signal: ctl.signal,
      keepalive: false,
    })
    const j = await r.json()
    if (j.error) throw new Error(j.error.message ?? 'rpc error')
    return j.result as T
  } finally {
    clearTimeout(t)
  }
}

export const blocks = new BlockStream()
