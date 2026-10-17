// 纯函数：从 store 状态算出画面要显示的实测值。不碰 DOM、不读 URL，
// 所以可以在 Node 里用假事件播放器自测（见 test/selftest.ts）。
import { formatEther, formatGwei } from 'viem'
import type { Proposal, SentinelOnProposal } from './store'
import { toBig, toNum } from './types'

type Receipt = NonNullable<SentinelOnProposal['receipt']>

const HEX = /^0x[0-9a-fA-F]+$/

/** 浏览器连结；没有前缀（本机/假事件）或值不像 hex 就回 null，画面改显示纯文字 */
export function explorerUrl(base: string | null | undefined, value: string | null | undefined): string | null {
  if (!base || !value || !HEX.test(value)) return null
  return base + value
}

/** 最先落地的否决收据：块号最小，同块比 latency */
export function firstReceipt(p: Proposal, sentinels: readonly string[]): { r: Receipt; who: string } | null {
  let best: Receipt | null = null
  let who = ''
  for (const s of sentinels) {
    const r = p.sentinels[s]?.receipt
    if (!r || r.block === null) continue
    if (!best || r.block < (best.block ?? 0) || (r.block === best.block && (r.latencyMs ?? 1e12) < (best.latencyMs ?? 1e12))) {
      best = r
      who = s
    }
  }
  return best ? { r: best, who } : null
}

export interface VetoMetrics {
  who: string
  txHash: string
  block: number
  /** 否决用了几块（提案块 → 否决收据块） */
  usedBlocks: number
  /** 攻击者还要等几块（否决收据块 → 可执行块） */
  waitBlocks: number
  /** 块数来自哪里：哨兵在 veto_receipt.extra 附的值，或用收据块号与提案块号相减 */
  blocksFrom: 'receipt.extra' | 'receipt.block'
  latencyMs: number | null
  vetoCount: number
  gasLimit: bigint | null
  gasUsed: bigint | null
  priceWei: bigint | null
  /** gasLimit × effectiveGasPrice（Monad 按 gasLimit 收费）；收据缺栏位就是 null，不补预设值 */
  costWei: bigint | null
}

/** 否决的实测数字，全部取自 veto_receipt；拿不到就回 null（画面显示等待，不用预设值） */
export function vetoMetrics(p: Proposal, sentinels: readonly string[]): VetoMetrics | null {
  const fr = firstReceipt(p, sentinels)
  if (!fr || fr.r.block === null) return null
  const ex = fr.r.extra ?? {}
  const exUsed = toNum(ex.vetoBlocksAfterPropose)
  const exWait = toNum(ex.blocksLeftForAttacker)
  let usedBlocks: number
  let waitBlocks: number
  let blocksFrom: VetoMetrics['blocksFrom']
  if (exUsed !== null && exWait !== null) {
    usedBlocks = exUsed
    waitBlocks = exWait
    blocksFrom = 'receipt.extra'
  } else if (p.proposeBlock && p.readyBlock) {
    usedBlocks = fr.r.block - p.proposeBlock
    waitBlocks = p.readyBlock - fr.r.block
    blocksFrom = 'receipt.block'
  } else {
    return null
  }
  const gasLimit = toBig(fr.r.gasLimit)
  const gasUsed = toBig(fr.r.gasUsed)
  const priceWei = toBig(fr.r.effectiveGasPrice)
  return {
    who: fr.who,
    txHash: fr.r.txHash,
    block: fr.r.block,
    usedBlocks,
    waitBlocks,
    blocksFrom,
    latencyMs: fr.r.latencyMs,
    vetoCount: sentinels.filter((s) => p.sentinels[s]?.receipt).length,
    gasLimit,
    gasUsed,
    priceWei,
    costWei: gasLimit !== null && priceWei !== null && priceWei > 0n ? gasLimit * priceWei : null,
  }
}

export function fmtMon(wei: bigint): string {
  const mon = Number(formatEther(wei))
  return `${mon.toPrecision(4)} MON`
}

export function fmtGwei(wei: bigint): string {
  const g = Number(formatGwei(wei))
  return `${Number.isInteger(g) ? g : g.toPrecision(4)} gwei`
}

/** AI 报告浮层是否自动显示：串流中显示；完成后 autoCloseMs 自动收起；被手动关掉的不再自动弹出 */
export function reportAutoVisible(p: Proposal | null, dismissedFor: string, now: number, autoCloseMs: number): boolean {
  if (!p || !p.report.open || !p.report.text) return false
  if (dismissedFor === p.id) return false
  if (p.report.done && p.report.doneTs !== undefined && now - p.report.doneTs >= autoCloseMs) return false
  return true
}

/** 实测出块时间是否可信（anvil 快进挖块会量出接近 0） */
export function plausibleBlockMs(bt: number | null, minMs: number): number | null {
  return bt !== null && bt >= minMs ? bt : null
}

/** 大区块计数器的字号：数字越长字越小，保证 1280 舞台上不溢出右上角栏位 */
export function blockFontPx(text: string, widthPx: number, maxPx: number): number {
  const n = Math.max(1, text.length)
  // 等宽字约 0.6em，再留 4% 余量；letter-spacing -0.02em 已算进去
  return Math.max(28, Math.min(maxPx, Math.floor(widthPx / (n * 0.6 * 1.04 - n * 0.02))))
}
