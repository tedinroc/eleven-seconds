import './style.css'
import { blocks } from './chain'
import { playFake, startFake, toggleFakeOffline } from './fake'
import { checkVerified, fillProposeTx } from './lookup'
import { startChainWatch, selectProposal } from './chainwatch'
import { MODE, READ_ONLY } from './runtime'
import { connectServices, getDriver, postDriver } from './sse'
import { store } from './store'
import { CARDS, type CardId } from './types'
import { judge, mountSkeleton, render, reportVisible, ui } from './ui'

mountSkeleton()

let dirty = true
const mark = () => {
  dirty = true
}
store.onChange(mark)
blocks.onChange(mark)
function loop() {
  if (dirty) {
    dirty = false
    if (MODE !== 'fake') {
      // 只读补查：缺提案交易哈希就查 Proposed log；合约地址查 Sourcify（测试网才有）
      if (!READ_ONLY) fillProposeTx()
      checkVerified(store.deploy?.guardedAdmin)
      const t = store.active?.target
      if (t) checkVerified(t)
    }
    render()
  }
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)
// 离线判定靠时间流逝，定时重画
setInterval(mark, 250)

if (MODE === 'fake') {
  startFake()
} else if (READ_ONLY) {
  // 云端只读版：区块头 + GuardedAdmin log 直接读测试网；不连 driver/哨兵/reporter
  blocks.start()
  startChainWatch()
} else {
  blocks.start()
  connectServices()
  void loadDeployments()
}

/** 地址一律由 driver 读 shared/deployments/*.json 后提供，前端不写死位址 */
async function loadDeployments() {
  for (;;) {
    try {
      const d = await getDriver<{ impls?: Record<string, string>; guardedAdmin?: string; proxy?: string; delayBlocks?: number; chainId?: number }>('/deployments')
      store.deploy = {
        guardedAdmin: typeof d.guardedAdmin === 'string' ? d.guardedAdmin : undefined,
        proxy: typeof d.proxy === 'string' ? d.proxy : undefined,
        delayBlocks: typeof d.delayBlocks === 'number' && d.delayBlocks > 0 ? d.delayBlocks : undefined,
        chainId: typeof d.chainId === 'number' ? d.chainId : undefined,
      }
      const map: Record<string, CardId | 'v1' | 'paused'> = { evilMint: 'evilMint', evilOwner: 'evilOwner', evilFee: 'evilFee', v2: 'v2', v1: 'v1', paused: 'paused' }
      for (const [k, addr] of Object.entries(d.impls ?? {})) if (map[k] && typeof addr === 'string') store.implNames.set(addr.toLowerCase(), map[k])
      mark()
      return
    } catch {
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
}

async function propose(card: CardId, isJudge: boolean) {
  if (READ_ONLY) return // 链上只读：现场提案由操作者触发
  if (isJudge) {
    judge.picked = card
    judge.status = '提案送出中…'
  }
  if (MODE === 'fake') {
    store.pendingJudge = isJudge
    playFake(card)
    if (isJudge) {
      judge.pickedId = store.activeId
      judge.status = '已送出（假事件）。判定后翻牌。'
      ui.judgeOpen = false
    }
    mark()
    return
  }
  try {
    const r = await postDriver<{ id: string; txHash: string; proposeBlock: number; readyBlock: number; target: string; codehash: string }>('/propose', { card })
    store.noteProposed(String(r.id), card, isJudge, r)
    if (isJudge) {
      judge.pickedId = String(r.id)
      judge.status = `已送出提案 #${r.id}。判定后翻牌。`
      ui.judgeOpen = false
    }
    store.log('driver', 'propose', `送出提案 #${r.id}${isJudge ? '（评委蒙牌）' : `（${CARDS.find((c) => c.id === card)?.name}）`} tx ${r.txHash.slice(0, 10)}…`, 'info')
  } catch (e) {
    const msg = (e as Error).message
    if (isJudge) {
      judge.status = `送出失败：${msg}`
      judge.picked = null
    }
    store.log('driver', 'propose', `提案失败：${msg}`, 'warn')
  }
  mark()
}

/** 严格模式（R5）用：approver 预核准 v2 的 codehash */
async function approveV2() {
  if (READ_ONLY) return
  try {
    const r = await postDriver<{ codehash: string; txHash: string }>('/approve', { card: 'v2' })
    store.log('driver', 'approve', `approver 已核准 v2 codehash ${r.codehash.slice(0, 10)}… tx ${r.txHash.slice(0, 10)}…`, 'good')
  } catch (e) {
    store.log('driver', 'approve', `核准失败：${(e as Error).message}`, 'warn')
  }
  mark()
}

function act(a: string) {
  if (READ_ONLY && (a === 'judge' || a === 'approve' || a === 'kill' || a === 'reshuffle' || a.startsWith('p:'))) return
  if (a.startsWith('sel:')) {
    selectProposal(a.slice(4))
    ui.reportDismissedFor = ''
  } else if (a === 'judge') {
    ui.judgeOpen = !ui.judgeOpen
    ui.tableOpen = false
  } else if (a === 'table') {
    ui.tableOpen = !ui.tableOpen
    ui.judgeOpen = false
  } else if (a === 'report') {
    if (reportVisible()) {
      ui.reportOpen = false
      ui.reportDismissedFor = store.activeId ?? ''
    } else {
      ui.reportOpen = true
    }
  } else if (a === 'close-report') {
    ui.reportOpen = false
    ui.reportDismissedFor = store.activeId ?? ''
  } else if (a === 'close-judge') ui.judgeOpen = false
  else if (a === 'close-table') ui.tableOpen = false
  else if (a === 'reshuffle') {
    judge.order = CARDS.map((c) => c.id)
    for (let i = judge.order.length - 1; i > 0; i--) {
      const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1)
      ;[judge.order[i], judge.order[j]] = [judge.order[j], judge.order[i]]
    }
    judge.picked = null
    judge.pickedId = null
    judge.status = ''
  } else if (a === 'kill' && MODE === 'fake') toggleFakeOffline('sentinel-3')
  else if (a.startsWith('p:')) void propose(a.slice(2) as CardId, false)
  else if (a === 'approve' && MODE !== 'fake') void approveV2()
  mark()
}

document.addEventListener('click', (ev) => {
  const t = ev.target as HTMLElement
  const btn = t.closest<HTMLElement>('[data-act]')
  if (btn) return act(btn.dataset.act!)
  const card = t.closest<HTMLElement>('[data-card]')
  if (card && !judge.picked && !READ_ONLY) void propose(card.dataset.card as CardId, true)
})

document.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return
  const k = ev.key.toLowerCase()
  if (k === 'j') act('judge')
  else if (k === 't') act('table')
  else if (k === 'r') act('report')
  else if (k === 'k') act('kill')
  else if (k === 'a') act('approve')
  else if (k === 'escape') {
    ui.judgeOpen = false
    ui.tableOpen = false
    ui.reportOpen = false
    ui.reportDismissedFor = store.activeId ?? ''
    mark()
  } else if (['1', '2', '3', '4'].includes(k)) void propose(CARDS[Number(k) - 1].id, false)
})
