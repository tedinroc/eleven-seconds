// 内建假事件播放器（?mode=fake）：不需要链、哨兵或 driver，就能完整播放
// 「恶意升级被否决」与「正常升级放行」。事件格式完全照 spec 4.4。
// 画面上所有数字都会标「假数据」，徽章是灰色「假事件演示」。
import { keccak256, stringToHex } from 'viem'
import { blocks } from './chain'
import { SENTINELS } from './runtime'
import { store } from './store'
import { CARDS, type CardId, type WarEvent } from './types'

const BLOCK_MS = 330 // 假链的出块间隔（只用于播放，不是实测）
let head = 1_000_000
let nextId = 1
const timers: number[] = []
const offline = new Set<string>()

function hex(seed: string, bytes: number): string {
  return keccak256(stringToHex(seed)).slice(0, 2 + bytes * 2)
}

function send(type: WarEvent['type'], source: string, fields: Partial<WarEvent>) {
  if (offline.has(source)) return
  store.ingest({ v: 1, type, ts: Date.now(), mode: 'testnet', source, ...fields } as WarEvent)
}

/** 在某块出现后 delay 毫秒执行 */
const waiters: { block: number; fn: () => void }[] = []
function atBlock(block: number, fn: () => void) {
  waiters.push({ block, fn })
}

function tick() {
  head++
  blocks.ingest(head, 'Proposed')
  blocks.ingest(head - 1, 'Voted')
  blocks.ingest(head - 2, 'Finalized')
  blocks.ingest(head - 5, 'Verified')
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (head >= waiters[i].block) {
      const w = waiters.splice(i, 1)[0]
      w.fn()
    }
  }
}

export function startFake() {
  blocks.setFake()
  timers.push(window.setInterval(tick, BLOCK_MS))
  for (const [i, s] of [...SENTINELS, 'driver', 'reporter'].entries()) {
    timers.push(
      window.setInterval(() => send('heartbeat', s, { lastBlock: head, rpc: ['monadinfra', 'ankr', 'monadinfra', 'local', 'local'][i], ok: true }), 500),
    )
  }
}

export function toggleFakeOffline(source = 'sentinel-3') {
  if (offline.has(source)) offline.delete(source)
  else offline.add(source)
}

const CHECKS: Record<CardId, { rule: string | null; checks: { name: string; before: string; after: string; ok: boolean }[]; selectors: string[] }> = {
  evilMint: {
    rule: 'R1_TOTAL_SUPPLY',
    checks: [
      { name: 'R1_TOTAL_SUPPLY', before: '21000000', after: '21000000 + 1e30', ok: false },
      { name: 'R2_OWNER', before: 'admin', after: 'admin', ok: true },
      { name: 'R3_TRANSFER_CONSERVATION', before: '-100 / +100', after: '-100 / +100', ok: true },
      { name: 'R4_TRANSFER_LIVENESS', before: 'ok', after: 'ok', ok: true },
    ],
    selectors: [],
  },
  evilOwner: {
    rule: 'R2_OWNER',
    checks: [
      { name: 'R1_TOTAL_SUPPLY', before: '21000000', after: '21000000', ok: true },
      { name: 'R2_OWNER', before: 'admin', after: '陌生地址', ok: false },
      { name: 'R3_TRANSFER_CONSERVATION', before: '-100 / +100', after: '-100 / +100', ok: true },
      { name: 'R4_TRANSFER_LIVENESS', before: 'ok', after: 'ok', ok: true },
    ],
    selectors: ['0x5e8d2b7a claimOwner()'],
  },
  evilFee: {
    rule: 'R3_TRANSFER_CONSERVATION',
    checks: [
      { name: 'R1_TOTAL_SUPPLY', before: '21000000', after: '21000000', ok: true },
      { name: 'R2_OWNER', before: 'admin', after: 'admin', ok: true },
      { name: 'R3_TRANSFER_CONSERVATION', before: '-100 / +100', after: '-100 / +90', ok: false },
      { name: 'R4_TRANSFER_LIVENESS', before: 'ok', after: 'ok', ok: true },
    ],
    selectors: [],
  },
  v2: {
    rule: null,
    checks: [
      { name: 'R1_TOTAL_SUPPLY', before: '21000000', after: '21000000', ok: true },
      { name: 'R2_OWNER', before: 'admin', after: 'admin', ok: true },
      { name: 'R3_TRANSFER_CONSERVATION', before: '-100 / +100', after: '-100 / +100', ok: true },
      { name: 'R4_TRANSFER_LIVENESS', before: 'ok', after: 'ok', ok: true },
    ],
    selectors: ['0x54fd4d50 version()'],
  },
}

const REPORTS: Record<CardId, string> = {
  evilMint: '新实现的 mint 不检查调用者，模拟中陌生地址直接增发，总供应量被改变。这等于任何人都能凭空印币。建议多签维持否决，并检查 admin 钥匙是否外泄。',
  evilOwner: '新实现新增 claimOwner()，模拟中陌生地址调用后成为 owner。攻击者可借此接管代币权限。建议多签维持否决，并轮换 admin 钥匙。',
  evilFee: '函数签名与原版完全一致，但模拟转账时收款方少收 10%，差额流向 owner。只比对 bytecode 规则抓不到这种行为。建议多签维持否决。',
  v2: '新实现只多一个 version()，模拟中总供应量、owner 与转账守恒全部不变。依目前检查可以放行，冷静期满后照常生效。',
}

const PATHS: ('ws' | 'poll')[] = ['ws', 'ws', 'poll']

export function playFake(card: CardId) {
  const id = String(nextId++)
  const proposeBlock = head + 1
  const readyBlock = proposeBlock + 30
  const info = CARDS.find((c) => c.id === card)!
  const target = hex(`impl-${card}-${id}`, 20)
  const codehash = hex(`code-${card}`, 32)
  const spec = CHECKS[card]
  const veto = info.expect === 'veto'
  const t0 = performance.now()
  store.noteProposed(id, card, store.pendingJudge, { proposeBlock, readyBlock, target, codehash, txHash: hex(`ptx-${id}`, 32) })
  store.pendingJudge = false

  atBlock(proposeBlock, () => {
    SENTINELS.forEach((s, i) => {
      const d = 120 + i * 90
      later(d, () => send('proposal_seen', s, { id, kind: 0, target, codehash, proposeBlock, readyBlock, path: PATHS[i] }))
      later(d + 15, () => send('sim_started', s, { id }))
      const simMs = 380 + i * 40
      later(d + 15 + simMs, () => {
        const ruleHash = spec.rule ? keccak256(stringToHex(`GUARD/${spec.rule}`)) : null
        send('sim_result', s, {
          id,
          verdict: veto ? 'veto' : 'pass',
          rule: spec.rule ? `GUARD/${spec.rule}` : null,
          ruleHash,
          checks: spec.checks,
          selectorsAdded: spec.selectors,
          simMs,
        })
        if (!veto) return
        const txHash = hex(`veto-${id}-${s}`, 32)
        later(30, () => send('veto_sent', s, { id, txHash, rpcs: ['official', 'monadinfra', 'ankr'] }))
        const vetoBlock = proposeBlock + 3 + (i === 2 ? 1 : 0)
        atBlock(vetoBlock, () =>
          later(60, () => {
            send('veto_receipt', s, {
              id,
              txHash,
              block: vetoBlock,
              status: 'success',
              gasUsed: 48211,
              gasLimit: 53032,
              effectiveGasPrice: '102000000000',
              latencyMs: Math.round(performance.now() - t0 - d),
            })
            atBlock(vetoBlock + 2, () => send('veto_finalized', s, { id, txHash, block: vetoBlock }))
          }),
        )
      })
    })
    // reporter：第一个 sim_result 之后逐字串流
    const text = REPORTS[card]
    const start = 900
    ;[...text].forEach((ch, k) => later(start + k * 35, () => send('report_token', 'reporter', { id, delta: ch })))
    const doneAt = start + text.length * 35 + 100
    const hash = keccak256(stringToHex(text))
    later(doneAt, () => send('report_done', 'reporter', { id, text, hash, cached: false }))
    later(doneAt + 700, () => send('reason_attached', 'sentinel-1', { id, txHash: hex(`attach-${id}`, 32), reportHash: hash }))
  })

  atBlock(readyBlock, () =>
    later(120, () =>
      send('execute_attempt', 'driver', {
        id,
        txHash: hex(`exec-${id}`, 32),
        result: veto ? 'reverted' : 'success',
        error: veto ? 'ProposalVetoed' : null,
        extra: veto ? { preflight: 'ProposalVetoed' } : { version: '2' },
      }),
    ),
  )
}

function later(ms: number, fn: () => void) {
  timers.push(window.setTimeout(fn, ms))
}
