// ?mode=chain（云端只读版）：浏览器直接读 Monad 测试网，不连 driver、哨兵、reporter。
//  - WS 订阅 GuardedAdmin 的 logs（区块头由 chain.ts 的 BlockStream 订阅 monadNewHeads）；
//  - 不论 WS 是否在线，都用 eth_getLogs 游标补洞（每次 ≤100 块，WS 断线时 1 秒一次，在线时 4 秒一次）；
//  - 开页时用 getProposal 载入最近 5 个提案，各自从 proposedBlock 起查 100 块的 log（一次 getLogs），没有现场触发时也有内容；
//  - 否决成本用 eth_getTransactionReceipt：gasUsed × effectiveGasPrice（Monad 的 gasUsed＝gasLimit）。
// 全部是 eth_call / eth_getLogs / eth_getTransactionReceipt，不签名、不广播。
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, numberToHex, pad, toEventSelector, type Abi, type Hex } from 'viem'
import { blocks } from './chain'
import { DATA } from './chaindata'
import { msg } from './i18n'
import { CHAIN, SENTINELS } from './runtime'
import { short, store, type Proposal } from './store'
import type { CardId } from './types'
import { AutoReplay, type ReplayFrame, type Timeline, type TLStep } from './replay'
import { CONFIG } from './config'
import { plausibleBlockMs } from './derive'

const ABI = DATA.abi as Abi
const GA = DATA.guardedAdmin as Hex
const MAX_RANGE = 100
const RECENT = 5
// 规格写 40 块；测试网实测 execute 可能落在提案后 42 块，所以用单次上限 100 块（仍是一次 getLogs）
const HISTORY_SPAN = MAX_RANGE

const EVENTS = ['Proposed', 'Vetoed', 'Executed', 'ReasonAttached'] as const
const TOPIC0 = Object.fromEntries(
  EVENTS.map((name) => {
    const ev = (ABI as readonly { type: string; name?: string }[]).find((x) => x.type === 'event' && x.name === name)
    return [name, toEventSelector(ev as never)]
  }),
) as Record<(typeof EVENTS)[number], Hex>
const ALL_TOPICS = EVENTS.map((e) => TOPIC0[e])

/** 画面上的状态文字按语言查 i18n（status.N）；这里留 zh-CN 原文给旧呼叫端 */
export const STATUS_CN = ['不存在', '冷静期中', '已否决', '已执行'] as const
const STATUS_NAME = ['None', 'Pending', 'Vetoed', 'Executed'] as const

/** guardian 地址（小写）→ 哨兵卡 */
export const GUARDIAN_CARD = new Map<string, string>(DATA.guardians.map((g, i) => [g.toLowerCase(), SENTINELS[i]]))
export const CARD_GUARDIAN = new Map<string, string>(DATA.guardians.map((g, i) => [SENTINELS[i], g]))
const RULE_BY_HASH = new Map<string, string>(DATA.rules.map((r) => [r.ruleHash.toLowerCase(), r.rule]))

/** 链上读取的健康状况（画面顶部显示） */
export const chainHealth = { logsLink: 'down' as 'ws' | 'poll' | 'down', cursor: 0, lastRpc: '', lastError: '', loadedRecent: false }

// ---------- HTTP JSON-RPC：轮换端点、逾时 8 秒、最多重试 4 次（会场新 TLS 连线 1.3–1.7 秒，偶发 handshake EOF） ----------
let rpcId = 1000
let httpIdx = 0
async function call<T>(method: string, params: unknown[], tries = 4): Promise<T> {
  let last: unknown
  for (let i = 0; i < tries; i++) {
    const url = CHAIN.http[httpIdx % CHAIN.http.length]
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 8000)
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
        signal: ctl.signal,
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = await r.json()
      if (j.error) throw new Error(j.error.message ?? 'rpc error')
      chainHealth.lastRpc = url
      return j.result as T
    } catch (e) {
      last = e
      httpIdx++
      chainHealth.lastError = `${method}: ${(e as Error).message}`
      await new Promise((r) => setTimeout(r, 300 * (i + 1)))
    } finally {
      clearTimeout(t)
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}

async function readContract<T>(functionName: string, args: unknown[] = []): Promise<T> {
  const data = encodeFunctionData({ abi: ABI, functionName, args } as never)
  const ret = await call<Hex>('eth_call', [{ to: GA, data }, 'latest'])
  return decodeFunctionResult({ abi: ABI, functionName, data: ret } as never) as T
}

interface RawLog {
  address: string
  topics: Hex[]
  data: Hex
  blockNumber: Hex
  transactionHash: Hex
  logIndex: Hex
  removed?: boolean
}

interface ChainProposal {
  kind: number
  status: number
  proposer: string
  target: string
  value: bigint
  codehash: string
  dataHash: string
  proposedBlock: bigint
  readyBlock: bigint
  vetoCount: bigint
}

// ---------- 状态写入 store（沿用 S1 画面的 Proposal 结构） ----------
/** arena.ts 也用：/api 回报的提案先建好，链上事件到了再补齐 */
export function ensure(id: string): Proposal {
  let p = store.proposals.get(id)
  if (!p) {
    p = { id, kind: '0', target: '', codehash: '', proposeBlock: null, readyBlock: null, firstTs: Date.now(), sentinels: {}, report: { text: '', done: false, open: false } }
    for (const s of SENTINELS) p.sentinels[s] = {}
    store.proposals.set(id, p)
  }
  return p
}

/** arena.ts 也用：新提案出现时切到最新一个（使用者手动选了旧提案就不切） */
export function pickActive() {
  let best: Proposal | null = null
  for (const p of store.proposals.values()) if (!best || Number(p.id) > Number(best.id)) best = p
  if (best && store.activeId !== best.id && !manualPick) store.activeId = best.id
}

/** 使用者点了最近提案列表里的某一个：新提案上链前不自动切走 */
let manualPick = false
export function selectProposal(id: string) {
  if (!store.proposals.has(id)) return
  // 使用者自己选提案：结束回放，闲置 60 秒后才再自动回放
  replay.stop(Date.now())
  store.activeId = id
  const newest = Math.max(...[...store.proposals.keys()].map(Number))
  manualPick = Number(id) !== newest
  store.emit()
}

export function recentIds(): string[] {
  return [...store.proposals.keys()].sort((a, b) => Number(b) - Number(a)).slice(0, RECENT)
}

function applyProposal(id: string, cp: ChainProposal) {
  const p = ensure(id)
  p.kind = String(cp.kind)
  p.target = cp.target
  p.codehash = cp.codehash
  p.proposeBlock = Number(cp.proposedBlock)
  p.readyBlock = Number(cp.readyBlock)
  p.chain = { status: cp.status, statusName: STATUS_NAME[cp.status] ?? String(cp.status), vetoCount: Number(cp.vetoCount), proposer: cp.proposer, readTs: Date.now() }
  const card = store.implNames.get(cp.target.toLowerCase())
  if (card && card !== 'v1' && card !== 'paused') p.card = card as CardId
  inferPass(p)
}

/** 链上没有「放行」事件：冷静期结束仍没有任何 Vetoed，或已 Executed，才把没否决的哨兵标成放行 */
function inferPass(p: Proposal) {
  const st = p.chain?.status
  const anyVeto = SENTINELS.some((s) => p.sentinels[s]?.verdict === 'veto')
  const over = st === 3 || (st === 1 && !anyVeto && p.readyBlock !== null && blocks.latest >= p.readyBlock)
  for (const s of SENTINELS) {
    const sp = p.sentinels[s]
    if (sp.verdict === 'veto') continue
    if (over && !anyVeto) sp.verdict = 'pass'
  }
}

const seenLogs = new Set<string>()
const receiptBusy = new Set<string>()

async function fillReceipt(id: string, s: string, txHash: string) {
  const key = `${id}|${s}`
  if (receiptBusy.has(key)) return
  receiptBusy.add(key)
  try {
    const r = await call<{ blockNumber: Hex; status: Hex; gasUsed: Hex; effectiveGasPrice?: Hex } | null>('eth_getTransactionReceipt', [txHash])
    if (!r) throw new Error('receipt 还没出来')
    const p = store.proposals.get(id)
    const sp = p?.sentinels[s]
    if (!sp?.receipt) return
    sp.receipt.status = r.status === '0x1' ? 'success' : 'reverted'
    sp.receipt.gasUsed = r.gasUsed ? BigInt(r.gasUsed).toString() : undefined
    // Monad 按 gasLimit 收费，收据的 gasUsed 就是 gasLimit
    sp.receipt.gasLimit = sp.receipt.gasUsed
    sp.receipt.effectiveGasPrice = r.effectiveGasPrice ? BigInt(r.effectiveGasPrice).toString() : undefined
    sp.receipt.block = parseInt(r.blockNumber, 16)
    store.emit()
  } catch {
    // 稍后再试
    setTimeout(() => {
      receiptBusy.delete(key)
      void fillReceipt(id, s, txHash)
    }, 3000)
    return
  }
}

const refreshBusy = new Set<string>()
async function refreshProposal(id: string) {
  if (refreshBusy.has(id)) return
  refreshBusy.add(id)
  try {
    const cp = await readContract<ChainProposal>('getProposal', [BigInt(id)])
    if (cp.status !== 0) {
      applyProposal(id, cp)
      pickActive()
      store.emit()
    }
  } catch {
    /* 下一次事件或轮询再读 */
  } finally {
    refreshBusy.delete(id)
  }
}

function handleLog(l: RawLog, live: boolean) {
  if (!l?.topics?.length || l.address?.toLowerCase() !== GA.toLowerCase()) return
  const key = `${l.transactionHash}|${l.logIndex}`
  if (l.removed) {
    store.logT('chain', 'removed', msg('cw.removed', { tx: short(l.transactionHash) }), 'warn')
    seenLogs.delete(key)
    store.emit()
    return
  }
  if (seenLogs.has(key)) return
  seenLogs.add(key)
  let ev: { eventName: string; args: Record<string, unknown> }
  try {
    ev = decodeEventLog({ abi: ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as never
  } catch {
    return
  }
  const id = String(ev.args.id)
  const block = parseInt(l.blockNumber, 16)
  const tx = l.transactionHash
  const p = ensure(id)
  const ts = Date.now()
  // 即时事件永远优先：立刻停止自动回放（闲置 60 秒后才会再回放）
  if (live) replay.onLive(ts)
  switch (ev.eventName) {
    case 'Proposed': {
      p.kind = String(ev.args.kind)
      p.target = String(ev.args.target)
      p.codehash = String(ev.args.codehash)
      p.proposeBlock = block
      p.readyBlock = Number(ev.args.readyBlock)
      p.proposeTx = tx
      const card = store.implNames.get(p.target.toLowerCase())
      if (card && card !== 'v1' && card !== 'paused') p.card = card as CardId
      if (live) {
        manualPick = false
        store.activeId = id
      }
      store.logT('chain', 'Proposed', msg('cw.proposed', { id, b: block, rb: p.readyBlock ?? '?', tx: short(tx) }), 'info', ts)
      break
    }
    case 'Vetoed': {
      const guardian = String(ev.args.guardian).toLowerCase()
      const s = GUARDIAN_CARD.get(guardian)
      const rule = RULE_BY_HASH.get(String(ev.args.ruleHash).toLowerCase()) ?? null
      if (s) {
        const sp = p.sentinels[s]
        sp.verdict = 'veto'
        sp.rule = rule ?? `ruleHash ${short(String(ev.args.ruleHash), 4)}`
        sp.ruleHash = String(ev.args.ruleHash)
        sp.vetoTx = tx
        sp.receipt = { txHash: tx, block, status: 'success', gasUsed: undefined, gasLimit: undefined, effectiveGasPrice: undefined, latencyMs: null }
        void fillReceipt(id, s, tx)
      }
      const who = s ? msg('cw.whoS', { n: s.split('-')[1] }) : msg('cw.whoUnknown', { g: short(guardian, 4) })
      const after = p.proposeBlock ? msg('cw.after', { n: block - p.proposeBlock }) : ''
      store.logT('chain', 'Vetoed', msg('cw.vetoed', { id, who, b: block, after, rule: rule ?? msg('cw.ruleUnknown'), n: String(ev.args.vetoCount) }), 'bad', ts)
      break
    }
    case 'Executed':
      p.execute = { txHash: tx, result: 'success', error: null, ts, block }
      store.logT('chain', 'Executed', msg('cw.executed', { id, b: block, tx: short(tx) }), 'good', ts)
      break
    case 'ReasonAttached':
      p.report.attachTx = tx
      p.report.reportHash = String(ev.args.reportHash)
      p.report.attachBlock = block
      store.logT('chain', 'ReasonAttached', msg('cw.reason', { id, h: short(String(ev.args.reportHash)) }), 'info', ts)
      break
  }
  pickActive()
  store.emit()
  void refreshProposal(id)
}

// ---------- 游标式 eth_getLogs 补洞 ----------
async function getLogs(from: number, to: number, idTopic?: Hex): Promise<RawLog[]> {
  const topics: unknown[] = [ALL_TOPICS]
  if (idTopic) topics.push(idTopic)
  return call<RawLog[]>('eth_getLogs', [{ address: GA, fromBlock: numberToHex(from), toBlock: numberToHex(to), topics }])
}

let polling = false
async function pollLogs() {
  if (polling) return
  polling = true
  try {
    const head = blocks.latest || parseInt(await call<Hex>('eth_blockNumber', []), 16)
    if (!chainHealth.cursor) chainHealth.cursor = head
    // 一次最多追 5 段（500 块），避免分页长时间关着后一次打爆端点
    for (let k = 0; k < 5 && chainHealth.cursor < head; k++) {
      const from = chainHealth.cursor + 1
      const to = Math.min(head, from + MAX_RANGE - 1)
      const logs = await getLogs(from, to)
      for (const l of logs) handleLog(l, true)
      chainHealth.cursor = to
    }
    if (chainHealth.logsLink !== 'ws') chainHealth.logsLink = 'poll'
  } catch {
    if (chainHealth.logsLink !== 'ws') chainHealth.logsLink = 'down'
  } finally {
    polling = false
  }
}

// ---------- WS 订阅 logs ----------
let ws: WebSocket | null = null
function openLogsWs() {
  if (CHAIN.ws.length === 0) return
  const url = CHAIN.ws[0]
  let sock: WebSocket
  try {
    sock = new WebSocket(url)
  } catch {
    setTimeout(openLogsWs, 3000)
    return
  }
  ws = sock
  sock.onopen = () => sock.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'eth_subscribe', params: ['logs', { address: GA }] }))
  sock.onmessage = (ev) => {
    let msg: any
    try {
      msg = JSON.parse(String(ev.data))
    } catch {
      return
    }
    if (msg.id === 7) {
      if (msg.result) {
        chainHealth.logsLink = 'ws'
        store.emit()
      } else sock.close()
      return
    }
    const l = msg?.params?.result
    if (l?.topics) handleLog(l as RawLog, true)
  }
  sock.onclose = () => {
    if (ws === sock) ws = null
    chainHealth.logsLink = 'poll'
    store.emit()
    setTimeout(openLogsWs, 3000)
  }
  sock.onerror = () => {
    /* onclose 接手 */
  }
}

// ---------- 开页载入最近 5 个提案 ----------
async function loadRecent() {
  for (let attempt = 0; ; attempt++) {
    try {
      const next = Number(await readContract<bigint>('nextId'))
      const head = parseInt(await call<Hex>('eth_blockNumber', []), 16)
      const ids: number[] = []
      for (let id = next - 1; id >= 1 && ids.length < RECENT; id--) ids.push(id)
      const props = await Promise.all(ids.map((id) => readContract<ChainProposal>('getProposal', [BigInt(id)]).then((cp) => [id, cp] as const)))
      for (const [id, cp] of props) if (cp.status !== 0) applyProposal(String(id), cp)
      pickActive()
      store.emit()
      // 每个提案从 proposedBlock 起查 100 块（Proposed、Vetoed、Executed、ReasonAttached 都在这段里）
      await Promise.all(
        props.map(async ([id, cp]) => {
          const from = Number(cp.proposedBlock)
          const to = Math.min(from + HISTORY_SPAN - 1, Math.max(head, blocks.latest))
          const logs = await getLogs(from, to, pad(numberToHex(BigInt(id)), { size: 32 }))
          for (const l of logs) handleLog(l, false)
        }),
      )
      chainHealth.loadedRecent = true
      store.logT('chain', 'load', msg('cw.loaded', { n: props.length, next }), 'info')
      store.emit()
      return
    } catch (e) {
      store.logT('chain', 'load', msg('cw.loadFail', { n: attempt + 1, err: (e as Error).message.slice(0, 80) }), 'warn')
      store.emit()
      await new Promise((r) => setTimeout(r, Math.min(10000, 2000 * (attempt + 1))))
    }
  }
}

export function startChainWatch() {
  store.deploy = { guardedAdmin: DATA.guardedAdmin, proxy: DATA.proxy, delayBlocks: DATA.delayBlocks, chainId: DATA.chainId }
  const map: Record<string, CardId | 'v1' | 'paused'> = { evilMint: 'evilMint', evilOwner: 'evilOwner', evilFee: 'evilFee', v2: 'v2', v1: 'v1', paused: 'paused' }
  for (const [k, addr] of Object.entries(DATA.impls as Record<string, string>)) if (map[k]) store.implNames.set(addr.toLowerCase(), map[k])
  void loadRecent()
  openLogsWs()
  // 游标：WS 在线时 4 秒补一次洞，断线时 1 秒一次
  let tick = 0
  setInterval(() => {
    tick++
    if (chainHealth.logsLink !== 'ws' || tick % 4 === 0) void pollLogs()
    // 冷静期内的提案：期满后重读一次 getProposal，好推断「未否决＝放行」
    for (const p of store.proposals.values()) {
      if (p.chain?.status === 1 && p.readyBlock && blocks.latest >= p.readyBlock && tick % 3 === 0) void refreshProposal(p.id)
      inferPass(p)
    }
  }, 1000)
}

// ---------- 链上真实事件自动回放（见 replay.ts；只在 chain 模式启动） ----------
function logReplayStep(tl: Timeline, st: TLStep, src: Proposal) {
  const id = tl.id
  const b = st.block
  switch (st.kind) {
    case 'proposed':
      store.logT('chain', 'Proposed', msg('cw.proposed', { id, b, rb: tl.readyBlock, tx: short(src.proposeTx) }), 'info', Date.now(), true)
      break
    case 'veto': {
      const sp = src.sentinels[st.sentinel ?? '']
      const n = tl.steps.filter((x) => x.kind === 'veto').indexOf(st) + 1
      const who = st.sentinel ? msg('cw.whoS', { n: st.sentinel.split('-')[1] }) : msg('cw.ruleUnknown')
      const real = sp?.receipt?.block ?? b
      store.logT('chain', 'Vetoed', msg('cw.vetoed', { id, who, b: real, after: msg('cw.after', { n: real - tl.proposeBlock }), rule: sp?.rule ?? msg('cw.ruleUnknown'), n }), 'bad', Date.now(), true)
      break
    }
    case 'reason':
      store.logT('chain', 'ReasonAttached', msg('cw.reason', { id, h: short(src.report.reportHash) }), 'info', Date.now(), true)
      break
    case 'ready':
      store.logT('chain', 'ready', tl.type === 'attack' ? msg('rp.readyVetoed', { id, b }) : msg('rp.readyPassed', { id, b }), tl.type === 'attack' ? 'bad' : 'good', Date.now(), true)
      break
    case 'executed':
      store.logT('chain', 'Executed', msg('cw.executed', { id, b: src.execute?.block ?? b, tx: short(src.execute?.txHash) }), 'good', Date.now(), true)
      break
  }
}

export const replay = new AutoReplay(Date.now(), logReplayStep)
const reducedMotion = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** 最新的提案还在冷静期内（即时提案）：不回放 */
function liveBusy(): boolean {
  let newest: Proposal | null = null
  for (const p of store.proposals.values()) if (!newest || Number(p.id) > Number(newest.id)) newest = p
  return !!newest && newest.chain?.status === 1 && newest.readyBlock !== null && blocks.latest > 0 && blocks.latest < newest.readyBlock
}

/** main.ts 每帧呼叫；回传是否要重画 */
export function tickReplay(now = Date.now()): boolean {
  if (!chainHealth.loadedRecent) return false
  return replay.tick(now, {
    proposals: store.proposals.values(),
    get: (id) => store.proposals.get(id),
    blockMs: plausibleBlockMs(blocks.blockTimeMs(), CONFIG.minPlausibleBlockMs),
    reduced: reducedMotion(),
    liveBusy: liveBusy(),
  })
}

export function replayFrame(now = Date.now()): ReplayFrame | null {
  return replay.frame(now, (id) => store.proposals.get(id))
}

export function toggleReplay() {
  replay.toggle(Date.now())
  store.emit()
}
