// 前端状态：合并 3 个哨兵、driver、reporter 的事件，按 proposal id 去重。
import { CONFIG } from './config'
import { MODE, SENTINELS } from './runtime'
import { EXTRA_EVENT_TEXT, isKnownEventType, normRule, toNum, type CardId, type Check, type WarEvent } from './types'

export interface SentinelOnProposal {
  seenTs?: number
  path?: string
  simStartedTs?: number
  verdict?: 'pass' | 'veto'
  rule?: string | null
  ruleHash?: string | null
  checks?: Check[]
  selectorsAdded?: string[]
  simMs?: number
  vetoTx?: string
  vetoRpcs?: string[]
  receipt?: {
    txHash: string
    block: number | null
    status: string
    gasUsed: unknown
    gasLimit: unknown
    effectiveGasPrice: unknown
    latencyMs: number | null
    /** 哨兵在收据事件 extra 里附的实测值（vetoBlocksAfterPropose、blocksLeftForAttacker） */
    extra?: Record<string, unknown>
  }
  finalizedBlock?: number | null
}

export interface Proposal {
  id: string
  kind: string
  target: string
  codehash: string
  proposeBlock: number | null
  readyBlock: number | null
  firstTs: number
  proposeTx?: string
  card?: CardId
  judge?: boolean
  dropped?: boolean
  sentinels: Record<string, SentinelOnProposal>
  execute?: { txHash?: string; result?: string; error?: string | null; extra?: Record<string, unknown>; ts: number }
  report: { text: string; done: boolean; hash?: string; cached?: boolean; attachTx?: string; reportHash?: string; open: boolean; doneTs?: number }
  /** 只有 ?mode=chain：getProposal 读到的链上状态（status 0 None／1 Pending／2 Vetoed／3 Executed） */
  chain?: { status: number; statusName: string; vetoCount: number; proposer: string; readTs: number }
}

export interface SourceHealth {
  lastTs: number
  lastBlock: number | null
  rpc: string
  ok: boolean
  sseOpen: boolean
}

export interface StreamLine {
  ts: number
  source: string
  type: string
  text: string
  level: 'info' | 'good' | 'bad' | 'warn'
}

const LS_KEY = `eleven.seen.${MODE}`

function loadSeen(): Set<string> {
  if (MODE === 'fake') return new Set()
  try {
    const raw = localStorage.getItem(LS_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

/** driver /deployments 给的部署资讯（前端不写死地址） */
export interface DeployInfo {
  guardedAdmin?: string
  proxy?: string
  delayBlocks?: number
  chainId?: number
}

/** Sourcify 查验结果：yes＝exact/match；no＝查得到但没验证；err＝网络失败（画面不下结论） */
export type VerifyState = 'pending' | 'yes' | 'no' | 'err'

export class Store {
  readonly loadTs = Date.now()
  proposals = new Map<string, Proposal>()
  activeId: string | null = null
  health = new Map<string, SourceHealth>()
  stream: StreamLine[] = []
  /** 上一次页面已看过的提案（id@proposeBlock），重新整理后不重播 */
  private seenBefore = loadSeen()
  /** 本次页面里被判定为「旧提案」的 id，其后续事件一律忽略 */
  private ignored = new Set<string>()
  private dedup = new Set<string>()
  private listeners = new Set<() => void>()
  /** driver /deployments 给的地址 → 卡片身份 */
  implNames = new Map<string, CardId | 'v1' | 'paused'>()
  pendingCards = new Map<string, { card: CardId; judge: boolean }>()
  /** 评委出题送出中：下一个建立的提案是蒙牌 */
  pendingJudge = false
  mixWarned = false
  deploy: DeployInfo | null = null
  verified = new Map<string, VerifyState>()

  onChange(fn: () => void) {
    this.listeners.add(fn)
  }
  emit() {
    for (const fn of this.listeners) fn()
  }

  get active(): Proposal | null {
    return this.activeId ? (this.proposals.get(this.activeId) ?? null) : null
  }

  private persistSeen(key: string) {
    if (MODE === 'fake') return
    this.seenBefore.add(key)
    try {
      localStorage.setItem(LS_KEY, JSON.stringify([...this.seenBefore].slice(-200)))
    } catch {
      /* 无痕模式等：忽略 */
    }
  }

  /** 未知或新增的事件类型：照实列进事件串流（截短），不改任何提案状态，也不会让页面出错。 */
  private logUnknown(source: string, e: WarEvent, id: string | null, ts: number) {
    const type = String(e.type).slice(0, 40)
    const label = EXTRA_EVENT_TEXT[type] ?? `未知事件 ${type}`
    const parts: string[] = []
    if (id) parts.push(`#${id}`)
    const rule = normRule(typeof e.rule === 'string' ? e.rule : null)
    if (rule) parts.push(rule)
    if (typeof e.txHash === 'string') parts.push(`tx ${short(e.txHash)}`)
    const msg = typeof e.error === 'string' ? e.error : typeof e.text === 'string' ? e.text : ''
    if (msg) parts.push(msg.length > 120 ? msg.slice(0, 120) + '…' : msg)
    const failed = /fail|error|revert/i.test(type) || e.ok === false
    this.log(source, type, `${label}${parts.length ? '：' + parts.join(' ') : ''}`, failed ? 'warn' : 'info', ts)
  }

  log(source: string, type: string, text: string, level: StreamLine['level'] = 'info', ts = Date.now()) {
    this.stream.push({ ts, source, type, text, level })
    if (this.stream.length > 80) this.stream.shift()
  }

  touch(source: string, patch: Partial<SourceHealth> = {}) {
    const h = this.health.get(source) ?? { lastTs: 0, lastBlock: null, rpc: '', ok: true, sseOpen: false }
    Object.assign(h, patch)
    this.health.set(source, h)
  }

  isOnline(source: string, now = Date.now()): boolean {
    const h = this.health.get(source)
    return !!h && now - h.lastTs < CONFIG.heartbeatTimeoutMs
  }

  /** driver /propose 回来后先建好提案（卡片身份只在前端记，不上画面直到翻牌） */
  noteProposed(id: string, card: CardId, judge: boolean, info: { txHash?: string; proposeBlock?: number; readyBlock?: number; target?: string; codehash?: string }) {
    const p = this.ensure(id, Date.now())
    p.card = card
    p.judge = judge
    if (info.txHash) p.proposeTx = info.txHash
    if (info.proposeBlock) p.proposeBlock = info.proposeBlock
    if (info.readyBlock) p.readyBlock = info.readyBlock
    if (info.target) p.target = info.target
    if (info.codehash) p.codehash = info.codehash
    this.activeId = id
    this.emit()
  }

  private ensure(id: string, ts: number): Proposal {
    let p = this.proposals.get(id)
    if (!p) {
      p = {
        id,
        kind: '0',
        target: '',
        codehash: '',
        proposeBlock: null,
        readyBlock: null,
        firstTs: ts,
        sentinels: {},
        report: { text: '', done: false, open: false },
      }
      for (const s of SENTINELS) p.sentinels[s] = {}
      const pend = this.pendingCards.get(id)
      if (pend) {
        p.card = pend.card
        p.judge = pend.judge
      }
      this.proposals.set(id, p)
    }
    return p
  }

  ingest(e: WarEvent) {
    if (!e || e.v !== 1 || typeof e.type !== 'string') return
    const ts = typeof e.ts === 'number' ? e.ts : Date.now()
    const source = String(e.source ?? '?')
    // 模式检查：测试网与本机数字不得混在一起
    if (MODE !== 'fake' && e.mode && e.mode !== MODE) {
      if (!this.mixWarned) {
        this.log(source, e.type, `收到 mode=${e.mode} 的事件，与当前模式不符，已丢弃（不混算）`, 'warn', ts)
        this.mixWarned = true
        this.emit()
      }
      return
    }
    this.touch(source, { lastTs: Date.now() })

    if (e.type === 'heartbeat') {
      this.touch(source, { lastBlock: toNum(e.lastBlock), rpc: String(e.rpc ?? ''), ok: e.ok !== false })
      return // 心跳不进事件串流
    }

    // 页面载入前的旧事件（SSE 重放积压）不重播
    if (ts < this.loadTs - 1500) return

    const id = e.id !== undefined && e.id !== null ? String(e.id) : null
    const key = `${source}|${e.type}|${id}|${e.txHash ?? ''}|${e.type === 'report_token' || !isKnownEventType(e.type) ? ts + (e.delta ?? '') : ''}`
    if (this.dedup.has(key)) return
    this.dedup.add(key)
    if (this.dedup.size > 5000) this.dedup.clear()

    if (!isKnownEventType(e.type)) {
      this.logUnknown(source, e, id, ts)
      this.emit()
      return
    }

    if (!id) return

    if (e.type === 'proposal_seen') {
      const seenKey = `${id}@${toNum(e.proposeBlock) ?? '?'}`
      if (this.seenBefore.has(seenKey) && !this.proposals.has(id)) {
        this.ignored.add(id)
        return
      }
      this.ignored.delete(id)
      this.persistSeen(seenKey)
    }
    if (this.ignored.has(id)) return
    // 没看过 proposal_seen 也没由 driver 建立的 id：多半是重新整理前的旧提案，不显示
    if (!this.proposals.has(id) && e.type !== 'proposal_seen' && e.type !== 'execute_attempt') return

    const p = this.ensure(id, ts)
    const s = p.sentinels[source] ?? (SENTINELS.includes(source as never) ? (p.sentinels[source] = {}) : undefined)

    switch (e.type) {
      case 'proposal_seen': {
        if (!this.activeId || p.firstTs >= (this.active?.firstTs ?? 0)) this.activeId = id
        if (e.kind !== undefined) p.kind = String(e.kind)
        if (e.target) p.target = e.target
        if (e.codehash) p.codehash = e.codehash
        p.proposeBlock = toNum(e.proposeBlock) ?? p.proposeBlock
        p.readyBlock = toNum(e.readyBlock) ?? p.readyBlock
        if (s) {
          s.seenTs = ts
          s.path = e.path
        }
        this.log(source, e.type, `看到提案 #${id}（${e.path ?? '?'}），提案块 ${p.proposeBlock ?? '?'}，可执行块 ${p.readyBlock ?? '?'}`, 'info', ts)
        break
      }
      case 'sim_started':
        if (s) s.simStartedTs = ts
        this.log(source, e.type, `开始模拟 #${id}`, 'info', ts)
        break
      case 'sim_result': {
        if (s) {
          s.verdict = e.verdict
          s.rule = normRule(e.rule)
          s.ruleHash = e.ruleHash ?? null
          s.checks = Array.isArray(e.checks) ? e.checks : []
          s.selectorsAdded = Array.isArray(e.selectorsAdded) ? e.selectorsAdded : []
          s.simMs = typeof e.simMs === 'number' ? e.simMs : undefined
        }
        const veto = e.verdict === 'veto'
        this.log(source, e.type, veto ? `判定否决 #${id}：${normRule(e.rule)}（模拟 ${e.simMs ?? '?'} ms）` : `判定放行 #${id}（模拟 ${e.simMs ?? '?'} ms）`, veto ? 'bad' : 'good', ts)
        break
      }
      case 'veto_sent':
        if (s) {
          s.vetoTx = e.txHash
          s.vetoRpcs = e.rpcs
        }
        this.log(source, e.type, `送出否决 #${id} tx ${short(e.txHash)}（${(e.rpcs ?? []).length} 路）`, 'warn', ts)
        break
      case 'veto_receipt':
        if (s) {
          s.vetoTx = e.txHash ?? s.vetoTx
          s.receipt = {
            txHash: String(e.txHash ?? ''),
            block: toNum(e.block),
            status: String(e.status ?? ''),
            gasUsed: e.gasUsed,
            gasLimit: e.gasLimit,
            effectiveGasPrice: e.effectiveGasPrice,
            latencyMs: typeof e.latencyMs === 'number' ? e.latencyMs : null,
            extra: e.extra && typeof e.extra === 'object' ? e.extra : undefined,
          }
        }
        this.log(source, e.type, `否决收据 #${id}：块 ${toNum(e.block) ?? '?'}，状态 ${e.status}，耗时 ${e.latencyMs ?? '?'} ms（收据≠终局）`, 'bad', ts)
        break
      case 'veto_finalized':
        if (s) s.finalizedBlock = toNum(e.block)
        this.log(source, e.type, `否决已终局 #${id}：块 ${toNum(e.block) ?? '?'}`, 'bad', ts)
        break
      case 'proposal_dropped':
        p.dropped = true
        this.log(source, e.type, `提案 #${id} 的 log 在终局前消失`, 'warn', ts)
        break
      case 'reason_attached':
        p.report.attachTx = e.txHash
        p.report.reportHash = e.reportHash
        this.log(source, e.type, `报告哈希已上链 #${id}：${short(e.reportHash)}`, 'info', ts)
        break
      case 'execute_attempt': {
        p.execute = { txHash: e.txHash, result: e.result, error: e.error ?? null, extra: e.extra, ts }
        const okx = e.result === 'success'
        this.log(source, e.type, okx ? `execute #${id} 成功 tx ${short(e.txHash)}` : `execute #${id} 回滚：${e.error ?? '?'} tx ${short(e.txHash)}`, okx ? 'good' : 'bad', ts)
        break
      }
      case 'report_token':
        if (p.report.done) break
        if ((e as { extra?: { restart?: boolean } }).extra?.restart) p.report.text = ''
        p.report.text += e.delta ?? ''
        p.report.open = true
        break
      case 'report_done':
        p.report.text = e.text ?? p.report.text
        p.report.hash = e.hash
        p.report.cached = !!e.cached
        p.report.done = true
        p.report.open = true
        // 用本机收到的时间算自动收起，避免各进程时钟不同步
        p.report.doneTs = Date.now()
        this.log(source, e.type, `AI 报告完成 #${id}${e.cached ? '（模板）' : ''} hash ${short(e.hash)}`, 'info', ts)
        break
    }
    this.emit()
  }
}

export function short(h: unknown, n = 6): string {
  const s = typeof h === 'string' ? h : ''
  if (!s) return '—'
  if (s.length <= 2 + n * 2) return s
  return `${s.slice(0, 2 + n)}…${s.slice(-4)}`
}

export const store = new Store()
