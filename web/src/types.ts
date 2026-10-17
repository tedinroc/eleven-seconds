// spec 4.4 的 SSE 事件。共同栏位 v/type/ts/mode/source；其余栏位按 type 不同。
// 不自行扩充栏位；需要额外资料一律放 extra。

export type EventType =
  | 'heartbeat'
  | 'proposal_seen'
  | 'sim_started'
  | 'sim_result'
  | 'veto_sent'
  | 'veto_receipt'
  | 'veto_finalized'
  | 'proposal_dropped'
  | 'reason_attached'
  | 'execute_attempt'
  | 'report_token'
  | 'report_done'

export const EVENT_TYPES: EventType[] = [
  'heartbeat',
  'proposal_seen',
  'sim_started',
  'sim_result',
  'veto_sent',
  'veto_receipt',
  'veto_finalized',
  'proposal_dropped',
  'reason_attached',
  'execute_attempt',
  'report_token',
  'report_done',
]

export interface Check {
  name: string
  before: unknown
  after: unknown
  ok: boolean
}

export interface WarEvent {
  v: 1
  // 未知类型（例如 veto_failed）也可能出现：只进事件串流，不进状态机
  type: EventType | (string & {})
  ts: number
  mode: 'testnet' | 'replay'
  source: string
  // 以下依 type 出现
  id?: string | number
  lastBlock?: number | string
  rpc?: string
  ok?: boolean
  kind?: number | string
  target?: string
  codehash?: string
  proposeBlock?: number | string
  readyBlock?: number | string
  path?: 'ws' | 'poll'
  verdict?: 'pass' | 'veto'
  rule?: string | null
  ruleHash?: string | null
  checks?: Check[]
  selectorsAdded?: string[]
  simMs?: number
  txHash?: string
  rpcs?: string[]
  block?: number | string
  status?: string | number
  gasUsed?: number | string
  gasLimit?: number | string
  effectiveGasPrice?: number | string
  latencyMs?: number
  reportHash?: string
  result?: 'success' | 'reverted'
  error?: string | null
  delta?: string
  text?: string
  hash?: string
  cached?: boolean
  extra?: Record<string, unknown>
}

export type CardId = 'evilMint' | 'evilOwner' | 'evilFee' | 'v2'

export interface CardInfo {
  id: CardId
  name: string
  desc: string
  expect: 'veto' | 'pass'
  expectRule: string | null
}

export const CARDS: CardInfo[] = [
  { id: 'evilMint', name: 'EvilMint', desc: '任何人都能 mint（Solv 模式，selector 与 v1 相同）', expect: 'veto', expectRule: 'R1_TOTAL_SUPPLY' },
  { id: 'evilOwner', name: 'EvilOwner', desc: '新增 claimOwner()，任何人可夺 owner', expect: 'veto', expectRule: 'R2_OWNER' },
  { id: 'evilFee', name: 'EvilFee', desc: 'selector 完全不变，transfer 偷抽 10% 给 owner', expect: 'veto', expectRule: 'R3_TRANSFER_CONSERVATION' },
  { id: 'v2', name: 'DemoBTC v2', desc: '正常升级，只多一个 version()', expect: 'pass', expectRule: null },
]

export const RULE_TEXT: Record<string, string> = {
  R1_TOTAL_SUPPLY: '陌生地址改变了总供应量（无权限增发）',
  R2_OWNER: '陌生地址改变了 owner（夺权）',
  R3_TRANSFER_CONSERVATION: '转账不守恒（偷抽成）',
  R4_TRANSFER_LIVENESS: '正常转账失败（升级成砖头）',
  R5_STRICT_CODEHASH: '严格模式：codehash 未经核准',
  R6_SIM_FAILURE: '模拟失败或超时，fail-closed 否决',
  R7_CONFIG_GUARD: '未经核准的配置变更',
  R8_INIT_DATA: '升级夹带未核准的初始化数据',
  R3B_THIRD_PARTY_FUNDS: '陌生地址的调用动了别人的余额（挪用第三方资金）',
  R9_NEW_OPCODES: '新实现多了旧版没有的危险 opcode（定时炸弹风险）',
}

// 事件串流里新增（或未来新增）的事件类型：只显示，不影响任何状态。
export const EXTRA_EVENT_TEXT: Record<string, string> = {
  veto_failed: '否决交易失败',
}

export function isKnownEventType(t: string): t is EventType {
  return (EVENT_TYPES as string[]).includes(t)
}

export const KIND_TEXT: Record<string, string> = {
  '0': '升级',
  '1': '设置哨兵',
  '2': '设置延迟',
  '3': '设置暂停实现',
}

export function normRule(rule: string | null | undefined): string | null {
  if (!rule) return null
  return rule.replace(/^GUARD\//, '')
}

export function toNum(x: unknown): number | null {
  if (x === null || x === undefined || x === '') return null
  if (typeof x === 'number') return Number.isFinite(x) ? x : null
  if (typeof x === 'bigint') return Number(x)
  if (typeof x === 'string') {
    const n = x.startsWith('0x') ? parseInt(x, 16) : Number(x)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export function toBig(x: unknown): bigint | null {
  try {
    if (x === null || x === undefined || x === '') return null
    if (typeof x === 'bigint') return x
    if (typeof x === 'number') return BigInt(Math.round(x))
    if (typeof x === 'string') return BigInt(x)
  } catch {
    return null
  }
  return null
}
