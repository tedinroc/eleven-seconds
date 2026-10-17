// ?mode=arena（云端互动版）：评委在网页按攻击卡，云端哨兵自动否决。
//  - 按钮 → POST /api/attack {card}（同源；Pages Function 经 service binding 转发到 arena Worker）
//    200/202 → 「已送出 #id」；429 → 「请稍候 N 秒」（Retry-After 标头或 JSON 的 retryAfter 秒数），倒数完才能再按
//  - 每 1.5 秒 GET /api/state：云端哨兵的判定细节（规则名、模拟毫秒、AI 报告全文）合并进 store，
//    画面沿用 chain 模式的战情室；链上事件（Proposed／Vetoed／Executed／ReasonAttached）仍由 chainwatch 直接读链。
//  - 自动回放沿用 replay.ts；有人按攻击（本页按钮、/api/state 出现新提案、链上 Proposed）立刻切回即时。
// /api/state 的栏位尽量宽松解析（normalizeState），Worker 增减栏位不会让页面出错。
import { CONFIG } from './config'
import { ensure, pickActive, replay } from './chainwatch'
import { msg, onLangChange, t } from './i18n'
import { SENTINELS } from './runtime'
import { store } from './store'
import { CARDS, normRule, type CardId } from './types'

export interface ArenaSentinel {
  verdict?: 'pass' | 'veto'
  rule?: string | null
  ruleHash?: string | null
  simMs?: number
  vetoTx?: string
}

export interface ArenaReport {
  text: string
  hash?: string
  done: boolean
  cached?: boolean
}

export interface ArenaProposal {
  id: string
  card?: CardId
  txHash?: string
  proposeBlock?: number
  readyBlock?: number
  target?: string
  codehash?: string
  sentinels: Record<string, ArenaSentinel>
  report?: ArenaReport
}

export interface ArenaHealth {
  online?: boolean
  lastBlock?: number | null
}

export interface ArenaState {
  proposals: ArenaProposal[]
  sentinels: Record<string, ArenaHealth>
  /** 距离下一次可以按攻击的秒数（Worker 有给才有；0＝现在可以按） */
  cooldownSec: number | null
  /** 云端正有一个提案在冷静期中（Worker limits.busy） */
  busy: boolean
}

export type ArenaStatus =
  | { kind: 'sending'; card: CardId }
  | { kind: 'sent'; card: CardId; id: string | null }
  | { kind: 'limited'; until: number }
  | { kind: 'error'; err: string }
  | { kind: 'timeout'; card: CardId }

/** 画面要读的 arena 状态（ui.ts） */
export const arena = {
  sending: null as CardId | null,
  status: null as ArenaStatus | null,
  /** 429 之后到这个时间（ms）才能再按 */
  retryUntil: 0,
  /** 最近一次成功读到 /api/state 的时间 */
  stateOkTs: 0,
  stateErr: '',
  health: {} as Record<string, ArenaHealth>,
  /** 云端正有一个提案在冷静期中（这段时间按攻击会被 429） */
  busy: false,
  /** /api/state 里已经看过的提案 id（第一次读到的不算「有人按攻击」） */
  seen: new Set<string>(),
  primed: false,
}

const CARD_IDS = new Set<string>(CARDS.map((c) => c.id))
const isCard = (x: unknown): x is CardId => typeof x === 'string' && CARD_IDS.has(x)
const cardName = (c: CardId | undefined) => (c ? t(`ar.card.${c}` as never).replace(/^[☠✓]\s*/, '') : '?')

const num = (x: unknown): number | undefined => {
  if (typeof x === 'number' && Number.isFinite(x)) return x
  if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x)
  return undefined
}
const str = (x: unknown): string | undefined => (typeof x === 'string' && x ? x : undefined)
const obj = (x: unknown): Record<string, unknown> | null => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null)

/** 'sentinel-1' / 'sentinel1' / 's1' / '1' / 1 / 阵列索引 → 'sentinel-1' */
export function sentinelName(x: unknown, idx?: number): string | null {
  const m = typeof x === 'number' ? String(x) : typeof x === 'string' ? (/(\d+)\s*$/.exec(x)?.[1] ?? null) : null
  const n = m !== null ? Number(m) : idx !== undefined ? idx + 1 : NaN
  const name = `sentinel-${n}`
  return (SENTINELS as string[]).includes(name) ? name : null
}

function normSentinel(raw: unknown): ArenaSentinel {
  const o = obj(raw) ?? {}
  const v = str(o.verdict) ?? str(o.decision) ?? (o.veto === true ? 'veto' : o.veto === false ? 'pass' : undefined)
  const out: ArenaSentinel = {}
  if (v === 'veto' || v === 'pass') out.verdict = v
  const rule = str(o.rule) ?? str(o.ruleName) ?? str(o.ruleId)
  if (rule) out.rule = normRule(rule)
  const rh = str(o.ruleHash)
  if (rh) out.ruleHash = rh
  const ms = num(o.simMs) ?? num(o.sim_ms) ?? num(o.simulationMs)
  if (ms !== undefined) out.simMs = Math.round(ms)
  const tx = str(o.vetoTx) ?? str(o.txHash) ?? str(o.tx)
  if (tx) out.vetoTx = tx
  return out
}

function normSentinels(raw: unknown): Record<string, ArenaSentinel> {
  const out: Record<string, ArenaSentinel> = {}
  if (Array.isArray(raw)) {
    raw.forEach((x, i) => {
      const o = obj(x)
      const name = sentinelName(o?.sentinel ?? o?.name ?? o?.source ?? o?.n ?? o?.index, i)
      if (name) out[name] = normSentinel(x)
    })
  } else {
    for (const [k, v] of Object.entries(obj(raw) ?? {})) {
      const name = sentinelName(k)
      if (name) out[name] = normSentinel(v)
    }
  }
  return out
}

function normReport(o: Record<string, unknown>): ArenaReport | undefined {
  const r = o.report
  if (typeof r === 'string' && r) return { text: r, hash: str(o.reportHash), done: o.reportDone !== false }
  const ro = obj(r)
  if (ro) {
    const text = str(ro.text) ?? str(ro.markdown) ?? ''
    if (!text) return undefined
    // Worker 的报告是 reporter 模板（template: true）→ 画面标「模板」而不是「AI」
    return { text, hash: str(ro.hash) ?? str(ro.reportHash), done: ro.done !== false, cached: ro.cached === true || ro.template === true }
  }
  const text = str(o.reportText)
  return text ? { text, hash: str(o.reportHash), done: o.reportDone !== false } : undefined
}

function normProposal(raw: unknown, key?: string): ArenaProposal | null {
  const o = obj(raw)
  if (!o) return null
  const idRaw = o.id ?? o.proposalId ?? key
  const id = typeof idRaw === 'number' || typeof idRaw === 'bigint' ? String(idRaw) : str(idRaw)
  if (!id || !/^\d+$/.test(id)) return null
  const p: ArenaProposal = { id, sentinels: normSentinels(o.sentinels ?? o.verdicts ?? o.results) }
  if (isCard(o.card)) p.card = o.card
  p.txHash = str(o.txHash) ?? str(o.proposeTx)
  p.proposeBlock = num(o.proposeBlock) ?? num(o.proposedBlock)
  p.readyBlock = num(o.readyBlock)
  p.target = str(o.target)
  p.codehash = str(o.codehash)
  p.report = normReport(o)
  return p
}

/** spec 4.4 事件阵列（Worker 若直接回传事件）折成提案 */
function foldEvents(events: unknown[], into: Map<string, ArenaProposal>) {
  for (const e of events) {
    const o = obj(e)
    if (!o || typeof o.type !== 'string' || o.id === undefined || o.id === null) continue
    const id = String(o.id)
    if (!/^\d+$/.test(id)) continue
    const p = into.get(id) ?? { id, sentinels: {} }
    into.set(id, p)
    const s = sentinelName(o.source)
    switch (o.type) {
      case 'proposal_seen':
        p.proposeBlock ??= num(o.proposeBlock)
        p.readyBlock ??= num(o.readyBlock)
        p.target ??= str(o.target)
        p.codehash ??= str(o.codehash)
        break
      case 'sim_result':
        if (s) p.sentinels[s] = { ...p.sentinels[s], ...normSentinel(o) }
        break
      case 'veto_sent':
      case 'veto_receipt':
        if (s && str(o.txHash)) p.sentinels[s] = { ...p.sentinels[s], vetoTx: str(o.txHash) }
        break
      case 'report_done':
        if (str(o.text)) p.report = { text: String(o.text), hash: str(o.hash), done: true, cached: o.cached === true }
        break
    }
  }
}

/** /api/state 的 JSON → ArenaState（宽松解析：提案可以是阵列或以 id 为键的物件，也接受 spec 4.4 事件阵列） */
export function normalizeState(j: unknown): ArenaState {
  const o = obj(j) ?? {}
  const map = new Map<string, ArenaProposal>()
  const list = o.proposals ?? o.attacks ?? o.recent
  if (Array.isArray(list)) {
    for (const x of list) {
      const p = normProposal(x)
      if (p) map.set(p.id, p)
    }
  } else {
    for (const [k, v] of Object.entries(obj(list) ?? {})) {
      const p = normProposal(v, k)
      if (p) map.set(p.id, p)
    }
  }
  if (Array.isArray(o.events)) foldEvents(o.events, map)
  const health: Record<string, ArenaHealth> = {}
  const hs = o.sentinels ?? o.health
  const addHealth = (name: string | null, v: unknown) => {
    const h = obj(v)
    if (!name || !h) return
    const online = typeof h.online === 'boolean' ? h.online : typeof h.ok === 'boolean' ? h.ok : undefined
    health[name] = { online, lastBlock: num(h.lastBlock) ?? null }
  }
  if (Array.isArray(hs)) hs.forEach((v, i) => addHealth(sentinelName(obj(v)?.name ?? obj(v)?.sentinel ?? obj(v)?.n, i), v))
  else for (const [k, v] of Object.entries(obj(hs) ?? {})) addHealth(sentinelName(k), v)
  // 三个云端哨兵跑在同一个 Worker 引擎里：引擎回报不健康时三张卡都标离线
  const eng = obj(o.engine)
  if (eng && eng.ok === false) for (const s of SENTINELS) health[s] = { ...health[s], online: false }
  // Worker 的 limits：busy＝有提案在冷静期中；其余是本访客／每小时／每日的间隔
  const lim = obj(o.limits) ?? obj(o.rateLimit)
  const busy = lim?.busy === true
  const limSec = lim
    ? busy
      ? (num(lim.busyRetryAfterSec) ?? 0)
      : Math.max(num(lim.ipRetryAfterSec) ?? 0, num(lim.hourRetryAfterSec) ?? 0, num(lim.dayRetryAfterSec) ?? 0, num(lim.retryAfter) ?? 0, num(lim.remainingSec) ?? 0)
    : null
  const cooldownSec = num(o.cooldownSec) ?? num(o.nextAttackInSec) ?? num(o.retryAfter) ?? limSec
  return { proposals: [...map.values()], sentinels: health, cooldownSec, busy }
}

/** 把云端哨兵的判定细节合并进 store；链上读到的事实（Vetoed 的 guardian、收据）优先，不被覆盖 */
export function mergeState(st: ArenaState, now = Date.now()) {
  let fresh: string | null = null
  for (const ap of st.proposals) {
    const isNew = !arena.seen.has(ap.id)
    arena.seen.add(ap.id)
    const p = ensure(ap.id)
    if (isNew && arena.primed) {
      // 有人按了攻击（可能是别的评委）：立刻切回即时
      replay.onLive(now)
      if (!fresh || Number(ap.id) > Number(fresh)) fresh = ap.id
      store.logT('arena', 'attack', msg('ar.logOther', { id: ap.id, card: cardName(ap.card ?? p.card) }), 'info', now)
    }
    if (ap.card && !p.card) p.card = ap.card
    if (ap.txHash && !p.proposeTx) p.proposeTx = ap.txHash
    if (ap.proposeBlock && !p.proposeBlock) p.proposeBlock = ap.proposeBlock
    if (ap.readyBlock && !p.readyBlock) p.readyBlock = ap.readyBlock
    if (ap.target && !p.target) p.target = ap.target
    if (ap.codehash && !p.codehash) p.codehash = ap.codehash
    for (const s of SENTINELS) {
      const d = ap.sentinels[s]
      if (!d) continue
      const sp = (p.sentinels[s] ??= {})
      if (d.verdict === 'veto') sp.verdict = 'veto'
      else if (d.verdict === 'pass' && sp.verdict !== 'veto') sp.verdict = 'pass'
      // 链上 Vetoed 读到的规则名优先；规则哈希对不上表时链上只写得出「ruleHash 0x…」，这时改用云端给的规则名
      if (d.rule && (!sp.rule || sp.rule.startsWith('ruleHash '))) sp.rule = d.rule
      if (d.ruleHash && !sp.ruleHash) sp.ruleHash = d.ruleHash
      if (d.simMs !== undefined) sp.simMs = d.simMs
      if (d.vetoTx && !sp.vetoTx) sp.vetoTx = d.vetoTx
    }
    const r = ap.report
    if (r && r.text && (p.report.text !== r.text || (r.done && !p.report.done))) {
      p.report.text = r.text
      p.report.open = true
      if (r.hash) p.report.hash = r.hash
      p.report.cached = !!r.cached
      if (r.done && !p.report.done) {
        p.report.done = true
        p.report.doneTs = now
      }
    }
  }
  arena.health = st.sentinels
  arena.busy = st.busy
  // Worker 给的剩余秒数为准（会增也会减）；送出中不动
  if (st.cooldownSec !== null && !arena.sending) arena.retryUntil = st.cooldownSec > 0 ? now + Math.ceil(st.cooldownSec) * 1000 : 0
  arena.primed = true
  if (fresh) pickActive()
  store.emit()
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

async function fetchT(f: FetchLike, url: string, init: RequestInit = {}, ms: number = CONFIG.arena.timeoutMs): Promise<Response> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), ms)
  try {
    return await f(url, { ...init, signal: ctl.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** 429 的剩余秒数：Retry-After 标头 → JSON 的 retryAfter／retryAfterSec／waitSec／remainingSec → 预设 10 秒 */
export function retrySeconds(headers: Headers | null, body: unknown): number {
  const h = headers?.get('retry-after')
  const fromH = h !== null && h !== undefined ? num(h) : undefined
  const o = obj(body) ?? {}
  const v = fromH ?? num(o.retryAfter) ?? num(o.retryAfterSec) ?? num(o.waitSec) ?? num(o.remainingSec) ?? num(o.retry_after)
  return v !== undefined && v > 0 ? Math.ceil(v) : 10
}

/** 剩几秒才能再按（0＝现在可以） */
export function waitLeft(now = Date.now()): number {
  return arena.retryUntil > now ? Math.ceil((arena.retryUntil - now) / 1000) : 0
}

/** 按下攻击卡 */
export async function attack(card: CardId, f: FetchLike = (u, i) => fetch(u, i), now = Date.now()): Promise<void> {
  if (!isCard(card) || arena.sending) return
  if (waitLeft(now) > 0) {
    arena.status = { kind: 'limited', until: arena.retryUntil }
    store.emit()
    return
  }
  arena.sending = card
  arena.status = { kind: 'sending', card }
  // 即时永远优先：一按就结束回放
  replay.onLive(now)
  store.emit()
  try {
    const r = await fetchT(f, `${CONFIG.arena.apiBase}/attack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ card }),
    }, CONFIG.arena.attackTimeoutMs)
    let body: unknown = null
    try {
      body = await r.json()
    } catch {
      body = null
    }
    const o = obj(body) ?? {}
    if (r.status === 429) {
      arena.retryUntil = Date.now() + retrySeconds(r.headers, body) * 1000
      arena.status = { kind: 'limited', until: arena.retryUntil }
      return
    }
    // 云端钱包快没测试币：Worker 暂停接受新攻击（免得送出没人付得起否决的提案）
    if (o.code === 'low_balance') {
      arena.status = { kind: 'error', err: t('ar.lowFunds') }
      return
    }
    if (!r.ok) throw new Error(str(o.error) ?? str(o.message) ?? `HTTP ${r.status}`)
    const idRaw = o.id ?? o.proposalId
    const id = typeof idRaw === 'number' ? String(idRaw) : (str(idRaw) ?? null)
    arena.status = { kind: 'sent', card, id: id && /^\d+$/.test(id) ? id : null }
    const cd = num(o.cooldownSec) ?? num(o.nextAttackInSec)
    if (cd && cd > 0) arena.retryUntil = Date.now() + cd * 1000
    if (id && /^\d+$/.test(id)) {
      arena.seen.add(id)
      const p = ensure(id)
      p.card = card
      const tx = str(o.txHash) ?? str(o.proposeTx)
      if (tx && !p.proposeTx) p.proposeTx = tx
      p.proposeBlock ??= num(o.proposeBlock) ?? null
      p.readyBlock ??= num(o.readyBlock) ?? null
      if (!p.target && str(o.target)) p.target = String(o.target)
      store.activeId = id
      pickActive()
      store.logT('arena', 'attack', msg('ar.logSent', { card: cardName(card), id }), 'info')
    }
  } catch (e) {
    // 逾时：提案可能已经送出（Worker 还在等收据），之后会出现在 /api/state 与链上
    if ((e as Error).name === 'AbortError') arena.status = { kind: 'timeout', card }
    else arena.status = { kind: 'error', err: String((e as Error).message ?? e).slice(0, 120) }
  } finally {
    arena.sending = null
    store.emit()
  }
}

/** 轮询一次 /api/state（selftest 直接呼叫） */
export async function pollState(f: FetchLike = (u, i) => fetch(u, i)): Promise<boolean> {
  try {
    const r = await fetchT(f, `${CONFIG.arena.apiBase}/state`, { cache: 'no-store', headers: { accept: 'application/json' } })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    mergeState(normalizeState(await r.json()))
    arena.stateOkTs = Date.now()
    arena.stateErr = ''
    return true
  } catch (e) {
    arena.stateErr = (e as Error).message || 'error'
    store.emit()
    return false
  }
}

export function startArena() {
  const title = () => {
    try {
      document.title = t('ar.docTitle')
    } catch {
      /* Node 自测 */
    }
  }
  title()
  onLangChange(title)
  const loop = async () => {
    // 分页在背景时放慢（省 Worker 请求数）
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
    if (!hidden) await pollState()
    setTimeout(loop, hidden ? CONFIG.arena.statePollMs * 4 : CONFIG.arena.statePollMs)
  }
  void loop()
}
