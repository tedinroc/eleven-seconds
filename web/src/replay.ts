// ?mode=chain（云端只读版）的「链上真实事件自动回放」。
// 只用 chainwatch 已经从链上读到的提案资料（提案块、readyBlock、各 guardian 的 Vetoed 块与 tx、
// ReasonAttached、Executed 块与 tx、receipt 成本），用虚拟区块时钟在画面上重演一次。
// 本档是纯逻辑：不碰 DOM、不开计时器、不读 store，时间一律由呼叫端传入（方便 selftest）。
// 即时事件永远优先：onLive() 立刻结束回放，闲置 idleMs 后才会再自动回放。
import type { Proposal, SentinelOnProposal } from './store'

export type StepKind = 'proposed' | 'veto' | 'reason' | 'ready' | 'executed'
export interface TLStep {
  block: number
  kind: StepKind
  sentinel?: string
}
export type ReplayType = 'attack' | 'v2'
export interface Timeline {
  id: string
  type: ReplayType
  /** 虚拟时钟起点：proposeBlock − LEAD_BLOCKS */
  start: number
  /** 虚拟时钟终点：readyBlock + TAIL_BLOCKS（v2 的 Executed 较晚时延到 Executed + TAIL_BLOCKS） */
  end: number
  proposeBlock: number
  readyBlock: number
  steps: TLStep[]
}

export const LEAD_BLOCKS = 2
export const TAIL_BLOCKS = 3
/** Executed 落在 readyBlock 后这么多块内，时间轴就延长到它；更晚就钉在时间轴末端（文字仍写真实块号） */
const EXEC_WINDOW = 40
const ORDER: Record<StepKind, number> = { proposed: 0, veto: 1, reason: 2, ready: 3, executed: 4 }
const STATUS_NAME = ['None', 'Pending', 'Vetoed', 'Executed'] as const

export const REPLAY = {
  /** 开页后这么久没有即时事件就开始回放 */
  firstDelayMs: 8000,
  /** 之后距离上一次即时事件超过这么久才再回放 */
  idleMs: 60000,
  /** 每段播完停在最终状态这么久，再播下一段 */
  gapMs: 4000,
  /** prefers-reduced-motion：直接显示最终状态，停这么久 */
  reducedHoldMs: 8000,
  /** 页面还没量到出块时间时用的秒/块 */
  defaultBlockMs: 400,
}

const vetoBlock = (sp: SentinelOnProposal | undefined): number | null =>
  sp?.verdict === 'veto' && typeof sp.receipt?.block === 'number' && sp.receipt.block > 0 ? sp.receipt.block : null

/** 能回放哪一种：链上 Vetoed 且有否决收据块号＝攻击；kind=Upgrade 且 Executed（有 tx）＝v2 */
export function replayType(p: Proposal): ReplayType | null {
  if (!p.proposeBlock || !p.readyBlock || p.readyBlock < p.proposeBlock) return null
  if (p.chain?.status === 2 && Object.values(p.sentinels).some((sp) => vetoBlock(sp) !== null)) return 'attack'
  if (p.chain?.status === 3 && p.kind === '0' && !!p.execute?.txHash && p.execute.result === 'success') return 'v2'
  return null
}

/** 从提案资料产生回放时间轴（事件按区块排序；同块按 Proposed → Vetoed → Reason → 冷静期满 → Executed） */
export function buildTimeline(p: Proposal): Timeline | null {
  const type = replayType(p)
  if (!type) return null
  const pb = p.proposeBlock!
  const rb = p.readyBlock!
  let end = rb + TAIL_BLOCKS
  const execBlock = type === 'v2' ? (p.execute?.block ?? null) : null
  if (execBlock !== null && execBlock > rb && execBlock - rb <= EXEC_WINDOW) end = Math.max(end, execBlock + TAIL_BLOCKS)
  const clamp = (b: number) => Math.min(end, Math.max(pb, b))
  const steps: TLStep[] = [{ block: pb, kind: 'proposed' }]
  const vetoes: TLStep[] = []
  for (const [s, sp] of Object.entries(p.sentinels)) {
    const b = vetoBlock(sp)
    if (b !== null) vetoes.push({ block: clamp(b), kind: 'veto', sentinel: s })
  }
  steps.push(...vetoes)
  if (p.report.attachTx) {
    const first = vetoes.length ? Math.min(...vetoes.map((v) => v.block)) : pb
    steps.push({ block: clamp(p.report.attachBlock ?? first), kind: 'reason' })
  }
  steps.push({ block: rb, kind: 'ready' })
  if (type === 'v2') steps.push({ block: clamp(execBlock ?? rb), kind: 'executed' })
  steps.sort((a, b) => a.block - b.block || ORDER[a.kind] - ORDER[b.kind] || String(a.sentinel).localeCompare(String(b.sentinel)))
  return { id: p.id, type, start: pb - LEAD_BLOCKS, end, proposeBlock: pb, readyBlock: rb, steps }
}

/** 最近一个被否决的攻击、最近一个已执行的 v2（id 最大者） */
export function pickReplay(proposals: Iterable<Proposal>): { attack: Proposal | null; v2: Proposal | null } {
  let attack: Proposal | null = null
  let v2: Proposal | null = null
  for (const p of proposals) {
    const ty = replayType(p)
    if (ty === 'attack' && (!attack || Number(p.id) > Number(attack.id))) attack = p
    if (ty === 'v2' && (!v2 || Number(p.id) > Number(v2.id))) v2 = p
  }
  return { attack, v2 }
}

/** 时间轴上虚拟区块 v 当下的提案样子（只放已发生的事件；收据物件沿用原物件，成本读到就会出现） */
export function snapshotAt(src: Proposal, tl: Timeline, v: number): Proposal {
  const reached = (kind: StepKind, s?: string) => tl.steps.some((st) => st.kind === kind && (s === undefined || st.sentinel === s) && st.block <= v)
  const proposed = v >= tl.proposeBlock
  const sentinels: Record<string, SentinelOnProposal> = {}
  let vetoes = 0
  for (const [s, sp] of Object.entries(src.sentinels)) {
    if (vetoBlock(sp) !== null && reached('veto', s)) {
      sentinels[s] = { ...sp }
      vetoes++
    } else sentinels[s] = {}
  }
  // 链上没有「放行」事件：冷静期满仍没有任何否决，才把哨兵标成未否决
  if (tl.type === 'v2' && vetoes === 0 && v >= tl.readyBlock) for (const s of Object.keys(sentinels)) sentinels[s] = { verdict: 'pass' }
  const executed = tl.type === 'v2' && reached('executed')
  const status = !proposed ? null : vetoes > 0 ? 2 : executed ? 3 : 1
  return {
    ...src,
    proposeTx: proposed ? src.proposeTx : undefined,
    sentinels,
    execute: executed ? src.execute : undefined,
    report: reached('reason') ? { ...src.report, open: false } : { text: '', done: false, open: false },
    chain:
      status === null
        ? undefined
        : { status, statusName: STATUS_NAME[status], vetoCount: vetoes, proposer: src.chain?.proposer ?? '', readTs: src.chain?.readTs ?? 0 },
  }
}

/** 回放的画面状态 */
export interface ReplayFrame {
  tl: Timeline
  /** 虚拟区块号（不是现在的区块） */
  vblock: number
  p: Proposal
  paused: boolean
  /** 已播到终点，停在最终状态 */
  hold: boolean
}

export interface ReplayCtx {
  proposals: Iterable<Proposal>
  get(id: string): Proposal | undefined
  /** 页面量到的秒/块（毫秒）；null 用 REPLAY.defaultBlockMs */
  blockMs: number | null
  reduced: boolean
  /** 有即时提案正在冷静期中：不回放（即时永远优先） */
  liveBusy: boolean
}

interface Seg {
  tl: Timeline
  t0: number
  msPerBlock: number
  reduced: boolean
  logged: number
}

/** 自动回放控制器：tick(now) 推进；onLive(now) 被即时事件打断；toggle(now) 是工具列／P 键的暂停与继续 */
export class AutoReplay {
  paused = false
  private seg: Seg | null = null
  private frozen: number | null = null
  private lastLive = 0
  private next: ReplayType = 'attack'
  private force = false

  private readonly loadTs: number
  private readonly onStep: (tl: Timeline, step: TLStep, src: Proposal) => void

  constructor(loadTs: number, onStep: (tl: Timeline, step: TLStep, src: Proposal) => void = () => {}) {
    this.loadTs = loadTs
    this.onStep = onStep
  }

  get active(): boolean {
    return this.seg !== null
  }

  /** 收到即时事件：立刻停止回放，从这一刻起重新计算闲置时间 */
  onLive(now: number) {
    this.lastLive = now
    this.seg = null
    this.frozen = null
    this.next = 'attack'
    this.force = false
  }

  /** 使用者自己选了提案：结束回放，闲置时间重算（与即时事件同样处理） */
  stop(now: number) {
    this.onLive(now)
  }

  private idleEnough(now: number): boolean {
    return this.lastLive ? now - this.lastLive >= REPLAY.idleMs : now - this.loadTs >= REPLAY.firstDelayMs
  }

  /** 暂停：冻结在目前的虚拟区块，也不再自动开始；继续：从冻结处接着播，没在播就马上开始 */
  toggle(now: number) {
    if (!this.paused) {
      this.paused = true
      if (this.seg) this.frozen = now - this.seg.t0
      return
    }
    this.paused = false
    if (this.seg && this.frozen !== null) this.seg.t0 = now - this.frozen
    else this.force = true
    this.frozen = null
  }

  private elapsed(now: number): number {
    return this.frozen ?? now - this.seg!.t0
  }

  private vblockAt(now: number): number {
    const s = this.seg!
    if (s.reduced) return s.tl.end
    return Math.min(s.tl.end, s.tl.start + Math.floor(this.elapsed(now) / s.msPerBlock))
  }

  private segDurationMs(s: Seg): number {
    return s.reduced ? REPLAY.reducedHoldMs : (s.tl.end - s.tl.start) * s.msPerBlock + REPLAY.gapMs
  }

  private startNext(now: number, ctx: ReplayCtx): boolean {
    const { attack, v2 } = pickReplay(ctx.proposals)
    const want = this.next === 'v2' && v2 ? v2 : (attack ?? v2)
    const tl = want ? buildTimeline(want) : null
    if (!tl) return false
    this.next = tl.type === 'attack' && v2 ? 'v2' : 'attack'
    const ms = ctx.blockMs && ctx.blockMs > 0 ? Math.min(1200, Math.max(150, ctx.blockMs)) : REPLAY.defaultBlockMs
    this.seg = { tl, t0: now, msPerBlock: ms, reduced: ctx.reduced, logged: 0 }
    this.frozen = null
    this.force = false
    return true
  }

  /** 推进时钟；回传画面是否需要重画 */
  tick(now: number, ctx: ReplayCtx): boolean {
    if (ctx.liveBusy) {
      if (!this.seg) return false
      this.seg = null
      this.frozen = null
      return true
    }
    if (this.paused) return false
    let changed = false
    if (this.seg && now - this.seg.t0 >= this.segDurationMs(this.seg)) {
      this.seg = null
      changed = true
    }
    if (!this.seg) {
      if (!this.force && !this.idleEnough(now)) return changed
      if (!this.startNext(now, ctx)) return changed
      changed = true
    }
    const s = this.seg!
    const v = this.vblockAt(now)
    const src = ctx.get(s.tl.id)
    while (s.logged < s.tl.steps.length && s.tl.steps[s.logged].block <= v) {
      if (src) this.onStep(s.tl, s.tl.steps[s.logged], src)
      s.logged++
      changed = true
    }
    return changed
  }

  /** 目前画面要显示的回放状态；没在回放就是 null */
  frame(now: number, get: (id: string) => Proposal | undefined): ReplayFrame | null {
    if (!this.seg) return null
    const src = get(this.seg.tl.id)
    if (!src) return null
    const vblock = this.vblockAt(now)
    return { tl: this.seg.tl, vblock, p: snapshotAt(src, this.seg.tl, vblock), paused: this.paused, hold: vblock >= this.seg.tl.end }
  }
}

/** 回放用的四段状态：块 b 在虚拟块 v 时走到第几段（Proposed 当块、Voted +1、Finalized +2、Verified +3） */
export function replayStage(b: number, v: number): number {
  if (!b || v < b) return -1
  return Math.min(3, v - b)
}
