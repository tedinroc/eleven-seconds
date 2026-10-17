// ?mode=arena（云端互动版）自测：攻击卡按钮、429 限流讯息、/api/state 合并、按攻击立刻结束回放。
// 不开浏览器、不连网：/api 用假的 fetch 回应。  npm run selftest（第二段）
import './arena-stub'
import { installDom } from './domstub'
import { arena, attack, mergeState, normalizeState, pollState, retrySeconds } from '../src/arena'
import { CONFIG } from '../src/config'
import { DATA } from '../src/chaindata'
import MAIN from '../src/chain-data.json'
import { chainHealth, ensure, replay, tickReplay } from '../src/chainwatch'
import { setLang, type Lang } from '../src/i18n'
import { ARENA, CHAIN, MODE, READ_ONLY, SENTINELS } from '../src/runtime'
import { store } from '../src/store'
import { render } from '../src/ui'

let fails = 0
function ok(cond: unknown, msg: string) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!cond) fails++
}
const TX = '0x' + 'ab'.repeat(32)

/** 假 /api：记下每次请求，按顺序回传预先排好的回应 */
function fakeFetch(replies: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const r = replies.shift() ?? { status: 500, body: { error: 'no reply queued' } }
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } })
  }
  return { f, calls }
}

// ---------- 1. 模式与资料 ----------
ok(MODE === 'arena' && ARENA && READ_ONLY, '?mode=arena：沿用 chain 的只读战情室（READ_ONLY）＋ arena 攻击卡')
ok(CHAIN.badge === 'Monad 测试网 · 云端互动', 'arena 徽章文字')
ok(DATA.guardedAdmin.toLowerCase() !== MAIN.guardedAdmin.toLowerCase(), `arena 读独立部署（GuardedAdmin ${DATA.guardedAdmin.slice(0, 10)}…，不是现场 demo 的合约）`)
ok(DATA.guardians.length === 3 && DATA.guardians.every((g) => !MAIN.guardians.map((x) => x.toLowerCase()).includes(g.toLowerCase())), 'arena 的 3 个 guardian 与现场 demo 不同')

const dom = installDom()
const html = () => dom.html()
const tb = () => dom.els.get('toolbar')?.innerHTML ?? ''

// ---------- 2. 按钮存在（三语） ----------
const LABELS: Record<Lang, string[]> = {
  'zh-CN': ['增发', '夺权', '抽成', '正常升级 v2', '按下攻击卡，云端哨兵会在冷静期内自动否决', '云端互动'],
  'zh-TW': ['增發', '奪權', '抽成', '正常升級 v2', '按下攻擊卡，雲端哨兵會在冷靜期內自動否決', '雲端互動'],
  en: ['Mint', 'Takeover', 'Fee skim', 'Upgrade v2', 'Press an attack card: cloud sentinels veto it during cooldown', 'Monad Testnet · Arena'],
}
for (const l of ['zh-CN', 'zh-TW', 'en'] as Lang[]) {
  setLang(l, false)
  render()
  const h = tb()
  const btns = ['evilMint', 'evilOwner', 'evilFee', 'v2'].filter((c) => h.includes(`data-act="atk:${c}"`))
  ok(btns.length === 4, `${l}：工具列有 4 张攻击卡按钮（${btns.join('、')}）`)
  const miss = LABELS[l].filter((w) => !html().includes(w))
  ok(miss.length === 0, `${l}：按钮文字、页首说明、徽章都有${miss.length ? `（缺：${miss.join('、')}）` : ''}`)
  ok(!/data-act="(judge|approve|kill|p:)/.test(h), `${l}：没有现场 demo 的操作钮（评委出题／核准／直接提案）`)
}
setLang('zh-CN', false)

// ---------- 3. 回放：开页不自动播，按 P 才播；有人按攻击立刻切回即时 ----------
{
  const p = ensure('3')
  p.kind = '0'
  p.proposeBlock = 1000
  p.readyBlock = 1030
  p.proposeTx = TX
  p.chain = { status: 2, statusName: 'Vetoed', vetoCount: 1, proposer: '', readTs: 0 }
  p.sentinels['sentinel-1'] = { verdict: 'veto', rule: 'R1_TOTAL_SUPPLY', vetoTx: TX, receipt: { txHash: TX, block: 1009, status: 'success', gasUsed: '123112', gasLimit: '123112', effectiveGasPrice: '102000000000', latencyMs: null } }
  chainHealth.loadedRecent = true
  tickReplay(Date.now() + 9000)
  ok(!replay.active && replay.paused, '回放：arena 开页不自动回放（停在最终状态，免得像有攻击在自动进行）')
  replay.toggle(Date.now())
  tickReplay(Date.now())
  ok(replay.active, '回放：按 P 才重播链上被否决的攻击')
}

// ---------- 4. 按攻击：200 → 已送出 #id ----------
{
  const { f, calls } = fakeFetch([{ status: 200, body: { ok: true, id: 7, card: 'evilMint', txHash: TX, proposeBlock: 2000, readyBlock: 2030 } }])
  await attack('evilMint', f)
  ok(calls.length === 1 && calls[0].url === '/api/attack' && calls[0].init?.method === 'POST' && JSON.parse(String(calls[0].init?.body)).card === 'evilMint', 'POST /api/attack {card:"evilMint"}')
  ok(!replay.active, '按下攻击立刻结束回放（即时优先）')
  ok(arena.status?.kind === 'sent' && store.activeId === '7', '送出后当前提案切到 #7')
  render()
  ok(tb().includes('已送出 #7'), '工具列显示「已送出 #7」')
  const p7 = store.proposals.get('7')!
  ok(p7.card === 'evilMint' && p7.proposeTx === TX && p7.proposeBlock === 2000 && p7.readyBlock === 2030, '提案 #7 先用 /api 回应建好（链上事件到了再补齐）')
}

// ---------- 5. 429 限流 ----------
{
  ok(retrySeconds(new Headers({ 'retry-after': '12' }), {}) === 12 && retrySeconds(null, { retryAfter: 7.2 }) === 8 && retrySeconds(null, {}) === 10, 'Retry-After 标头／JSON retryAfter／预设 10 秒')
  const { f, calls } = fakeFetch([{ status: 429, body: { error: 'rate_limited', retryAfter: 12 }, headers: { 'retry-after': '12' } }])
  await attack('evilOwner', f)
  render()
  ok(arena.status?.kind === 'limited', '429 → 限流状态')
  ok(/请稍候 1[12] 秒再按/.test(tb()), `工具列显示剩余秒数（${/请稍候 \d+ 秒/.exec(tb())?.[0] ?? '没有'}）`)
  ok((tb().match(/data-act="atk:[^"]+"[^>]* disabled/g) ?? []).length === 4, '倒数期间 4 张攻击卡都停用')
  await attack('evilOwner', f)
  ok(calls.length === 1, '倒数期间再按不会再送请求')
  setLang('en', false)
  render()
  ok(/Please wait 1[12] s/.test(tb()), '429 讯息英文版')
  setLang('zh-TW', false)
  render()
  ok(/請稍候 1[12] 秒再按/.test(tb()), '429 讯息繁体版')
  setLang('zh-CN', false)
  arena.retryUntil = 0
  render()
  ok(tb().includes('可以再按一次') && !/atk:[^"]+"[^>]* disabled/.test(tb()), '倒数结束：按钮恢复、提示可以再按')
}

// ---------- 6. 送出失败 ----------
{
  const { f } = fakeFetch([{ status: 503, body: { error: 'ARENA binding not configured' } }])
  await attack('evilFee', f)
  render()
  ok(arena.status?.kind === 'error' && tb().includes('送出失败：ARENA binding not configured'), '非 2xx：显示送出失败与原因')
}

// ---------- 7. /api/state 合并进哨兵卡与 AI 报告 ----------
{
  const REPORT = '提案 #7 的新实现让任意地址都能 mint：总供应量从 175 亿变成 175 亿＋1 亿。云端哨兵 1 在冷静期第 9 块否决。'
  const { f, calls } = fakeFetch([
    {
      status: 200,
      body: {
        proposals: [
          {
            id: '7',
            card: 'evilMint',
            sentinels: {
              'sentinel-1': { verdict: 'veto', rule: 'GUARD/R1_TOTAL_SUPPLY', simMs: 42, vetoTx: TX },
              'sentinel-2': { verdict: 'veto', rule: 'R1_TOTAL_SUPPLY', simMs: 57 },
            },
            report: { text: REPORT, hash: '0x' + '12'.repeat(32), done: true },
          },
        ],
        sentinels: { 'sentinel-1': { online: true, lastBlock: 2010 }, 'sentinel-3': { online: false } },
      },
    },
  ])
  ok(await pollState(f), 'GET /api/state 成功')
  ok(calls[0].url === '/api/state', '轮询的是 /api/state')
  const p = store.proposals.get('7')!
  ok(p.sentinels['sentinel-1'].verdict === 'veto' && p.sentinels['sentinel-1'].rule === 'R1_TOTAL_SUPPLY' && p.sentinels['sentinel-1'].simMs === 42, '哨兵 1：否决、规则名（去掉 GUARD/ 前缀）、模拟 42 ms')
  ok(p.sentinels['sentinel-2'].simMs === 57 && p.sentinels['sentinel-3'].verdict === undefined, '哨兵 2 合并、哨兵 3 没资料就不动')
  ok(p.report.text === REPORT && p.report.done && p.report.open, 'AI 报告全文合并进提案')
  render()
  const s1 = dom.els.get('s-sentinel-1')!.innerHTML
  ok(s1.includes('R1') && s1.includes('模拟 42 ms') && s1.includes('云端'), '哨兵卡显示规则名与模拟毫秒')
  ok(dom.els.get('s-sentinel-3')!.innerHTML.includes('离线'), '云端哨兵 3 回报离线时哨兵卡标示离线')
  const rep = dom.els.get('ov-report')!.innerHTML
  ok(rep.includes('总供应量从 175 亿') && rep.includes('#7'), 'AI 报告面板显示全文')
  // 链上事实优先：链上 Vetoed 已写入的 vetoTx 不被覆盖
  const other = '0x' + 'cd'.repeat(32)
  p.sentinels['sentinel-2'].vetoTx = other
  mergeState(normalizeState({ proposals: [{ id: 7, sentinels: { 'sentinel-2': { verdict: 'pass', txHash: TX } } }] }))
  ok(p.sentinels['sentinel-2'].vetoTx === other && p.sentinels['sentinel-2'].verdict === 'veto', '已否决的不会被改成放行；已有的 vetoTx 不被覆盖')
}

// ---------- 8. 其他评委按的攻击（/api/state 出现新提案）也会结束回放 ----------
{
  replay.toggle(Date.now())
  replay.toggle(Date.now())
  tickReplay(Date.now())
  ok(replay.active, '（准备）手动继续回放')
  mergeState(normalizeState({ proposals: { 8: { card: 'v2', sentinels: [{ verdict: 'pass', simMs: 31 }, { verdict: 'pass' }, { verdict: 'pass' }] } } }))
  ok(!replay.active, '/api/state 出现新提案 → 立刻结束回放')
  ok(store.activeId === '8' && store.proposals.get('8')!.card === 'v2', '新提案成为当前提案')
  ok(SENTINELS.every((s) => store.proposals.get('8')!.sentinels[s].verdict === 'pass') && store.proposals.get('8')!.sentinels['sentinel-1'].simMs === 31, '哨兵阵列格式也能合并（v2 三个放行）')
  ok(store.stream.some((l) => l.type === 'attack' && l.text.includes('#8')), '事件串流记一句「云端收到新提案 #8」')
}

// ---------- 9. 宽松解析 ----------
{
  const st = normalizeState({
    events: [
      { v: 1, type: 'proposal_seen', source: 'sentinel-1', id: 9, proposeBlock: 3000, readyBlock: 3030 },
      { v: 1, type: 'sim_result', source: 'sentinel-2', id: 9, verdict: 'veto', rule: 'R2_OWNER', simMs: 88 },
      { v: 1, type: 'report_done', source: 'reporter', id: 9, text: 'report', hash: '0x01' },
    ],
    cooldownSec: 5,
  })
  const p9 = st.proposals.find((p) => p.id === '9')
  ok(p9?.proposeBlock === 3000 && p9.sentinels['sentinel-2']?.rule === 'R2_OWNER' && p9.sentinels['sentinel-2']?.simMs === 88 && p9.report?.text === 'report', 'spec 4.4 事件阵列也能折成提案')
  ok(st.cooldownSec === 5, 'cooldownSec 读得到')
  let threw = false
  try {
    normalizeState(null)
    normalizeState({ proposals: [null, 1, 'x', { id: 'not-a-number' }, { id: 10, sentinels: 'bad' }] })
    mergeState(normalizeState({ proposals: 'garbage' }))
  } catch {
    threw = true
  }
  ok(!threw, '格式不对的 /api/state 不会让页面出错')
  const { f } = fakeFetch([{ status: 502, body: { error: 'bad gateway' } }])
  ok(!(await pollState(f)) && arena.stateErr === 'HTTP 502', '/api/state 失败时记下错误、下次再试')
}

// ---------- 10. arena Worker 的实际回应格式（arena/worker：sentinels 阵列带 index、模板报告、limits） ----------
{
  const st = normalizeState({
    ok: true,
    limits: { busy: true, busyRetryAfterSec: 14, ipRetryAfterSec: 0, hourRetryAfterSec: 0, dayRetryAfterSec: 0 },
    engine: { ok: true },
    proposals: [
      {
        id: 21,
        card: 'evilFee',
        proposeTx: TX,
        proposeBlock: 5000,
        readyBlock: 5030,
        status: 'pending',
        sentinels: [
          { index: 1, verdict: 'veto', rule: 'R3_TRANSFER_CONSERVATION', simMs: 61, vetoTx: TX },
          { index: 2, verdict: 'veto', rule: 'R3_TRANSFER_CONSERVATION', simMs: 73 },
          { index: 3, verdict: 'veto', rule: 'R3_TRANSFER_CONSERVATION', simMs: 80 },
        ],
        report: { text: 'template report', hash: '0x02', template: true, attachTx: TX },
      },
    ],
  })
  const p = st.proposals[0]
  ok(p.id === '21' && p.card === 'evilFee' && p.txHash === TX && p.proposeBlock === 5000 && p.readyBlock === 5030, 'Worker 提案栏位（id 数字、proposeTx、区块）')
  ok(p.sentinels['sentinel-1']?.simMs === 61 && p.sentinels['sentinel-3']?.rule === 'R3_TRANSFER_CONSERVATION', 'Worker 的 sentinels 阵列用 index 对到哨兵卡')
  ok(p.report?.cached === true, 'Worker 的模板报告标成「模板」而不是 AI')
  ok(st.busy && st.cooldownSec === 14, 'limits.busy → 云端忙、14 秒后可再按')
  mergeState(st)
  render()
  ok(/云端正在处理上一个提案，约 1[34] 秒后可以再按/.test(tb()), '云端忙时显示等待秒数（不用先按）')
  ok((tb().match(/data-act="atk:[^"]+"[^>]* disabled/g) ?? []).length === 4, '云端忙时攻击卡停用')
  mergeState(normalizeState({ limits: { busy: false, busyRetryAfterSec: 0, ipRetryAfterSec: 0, hourRetryAfterSec: 0, dayRetryAfterSec: 0 }, proposals: [] }))
  render()
  ok(!/atk:[^"]+"[^>]* disabled/.test(tb()), '云端空闲后攻击卡恢复')
  const eng = normalizeState({ engine: { ok: false }, proposals: [] })
  ok(SENTINELS.every((s) => eng.sentinels[s]?.online === false), '引擎不健康 → 三张哨兵卡标离线')
  // 202（还没拿到 id）
  const { f } = fakeFetch([{ status: 202, body: { ok: true, pending: true, card: 'v2', txHash: TX, id: null } }])
  await attack('v2', f)
  render()
  ok(arena.status?.kind === 'sent' && tb().includes('已送出（正常升级 v2），等待上链'), '202 没有 id：显示「已送出，等待上链」')
}

// ---------- 11. 攻击逾时：Worker 最多等 12 秒收据，前端逾时要更长，逾时也不说失败 ----------
{
  ok(CONFIG.arena.attackTimeoutMs > 12000, `POST /api/attack 逾时 ${CONFIG.arena.attackTimeoutMs} ms（比 Worker 等收据的 12 秒长）`)
  arena.retryUntil = 0
  const abort = async () => {
    const e = new Error('aborted')
    e.name = 'AbortError'
    throw e
  }
  await attack('evilOwner', abort)
  render()
  ok(arena.status?.kind === 'timeout' && tb().includes('已送出但回应较慢') && !tb().includes('送出失败'), '逾时显示「已送出但回应较慢」，不显示失败')
}

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exit(fails ? 1 : 0)
