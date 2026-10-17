// 前端逻辑自测（不开浏览器）：在 Node 里跑 ?mode=fake 的假事件播放器，检查画面要用的实测值。
//   npm run selftest
import './stub'
import { installDom } from './domstub'
import { CONFIG } from '../src/config'
import { blockFontPx, explorerUrl, fmtGwei, fmtMon, plausibleBlockMs, reportAutoVisible, vetoMetrics } from '../src/derive'
import { playFake, startFake, toggleFakeOffline } from '../src/fake'
import { DICT, initLang, lang, LANG_LABEL, LANGS, setLang, tm, type Lang } from '../src/i18n'
import { SENTINELS } from '../src/runtime'
import { store, type Proposal } from '../src/store'
import { RULE_TEXT } from '../src/types'
import { judge, render, ui } from '../src/ui'
import { AutoReplay, buildTimeline, pickReplay, REPLAY, replayStage, snapshotAt, type Timeline, type TLStep } from '../src/replay'

let fails = 0
function ok(cond: unknown, msg: string) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!cond) fails++
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(fn: () => boolean, ms: number) {
  const t = Date.now()
  while (!fn() && Date.now() - t < ms) await sleep(50)
  return fn()
}

// ---------- 1. 纯函数 ----------
const TX = '0x21fe66f7' + 'ab'.repeat(28)
ok(explorerUrl(CONFIG.chains.testnet.explorerTx, TX) === `https://testnet.monadexplorer.com/tx/${TX}`, 'tx 连结用 testnet.monadexplorer.com/tx/')
ok(explorerUrl(CONFIG.chains.testnet.explorerAddr, '0x57a84DCaDB3C29aeF27Cd5d7f3A3Af2C27F25ef4') === 'https://testnet.monadexplorer.com/address/0x57a84DCaDB3C29aeF27Cd5d7f3A3Af2C27F25ef4', '地址连结用 /address/')
ok(explorerUrl(CONFIG.chains.replay.explorerTx, TX) === null, '本机重演没有浏览器连结')
ok(explorerUrl(CONFIG.chains.testnet.explorerTx, '"><script>') === null, '非 hex 值不产生连结')
ok(plausibleBlockMs(3, CONFIG.minPlausibleBlockMs) === null && plausibleBlockMs(400, CONFIG.minPlausibleBlockMs) === 400, '快进挖块（≈0 秒/块）不当实测')
for (const txt of ['#548', '#1,000,123', '#71,719,034', '#171,719,034']) {
  const f = blockFontPx(txt, 396, 84)
  ok(txt.length * 0.6 * f <= 396 && f <= 84, `区块数字 ${txt} 字号 ${f}px 放得进 396px`)
}

// 今天测试网的真实数字（提案 #1：块 71719034，readyBlock 71719064；哨兵 1 在 71719043 落地）
function mkProposal(): Proposal {
  const p: Proposal = { id: '1', kind: '0', target: '', codehash: '', proposeBlock: 71719034, readyBlock: 71719064, firstTs: 0, sentinels: {}, report: { text: '', done: false, open: false } }
  const rc = (block: number, latencyMs: number, extra?: Record<string, unknown>) => ({ txHash: TX, block, status: 'success', gasUsed: 123112, gasLimit: 123112, effectiveGasPrice: '102000000000', latencyMs, extra })
  p.sentinels['sentinel-1'] = { receipt: rc(71719043, 2681, { vetoBlocksAfterPropose: 9, blocksLeftForAttacker: 21 }) }
  p.sentinels['sentinel-2'] = { receipt: rc(71719044, 3060) }
  p.sentinels['sentinel-3'] = { receipt: rc(71719045, 3556) }
  return p
}
{
  const m = vetoMetrics(mkProposal(), SENTINELS)!
  ok(m && m.who === 'sentinel-1' && m.usedBlocks === 9 && m.waitBlocks === 21, `测试网实测：否决用了 ${m?.usedBlocks} 块／攻击者还要等 ${m?.waitBlocks} 块（期望 9／21）`)
  ok(m.blocksFrom === 'receipt.extra', '块数优先取 veto_receipt.extra')
  ok(m.costWei !== null && fmtMon(m.costWei) === '0.01256 MON', `单次否决成本 ${m.costWei !== null ? fmtMon(m.costWei) : '—'}（期望 0.01256 MON）`)
  ok(m.priceWei !== null && fmtGwei(m.priceWei) === '102 gwei', 'effectiveGasPrice 显示 102 gwei')
  ok(m.vetoCount === 3 && m.latencyMs === 2681, '3/3 已否决、最先落地 2.68 秒')
  const p2 = mkProposal()
  delete p2.sentinels['sentinel-1'].receipt!.extra
  const m2 = vetoMetrics(p2, SENTINELS)!
  ok(m2.usedBlocks === 9 && m2.waitBlocks === 21 && m2.blocksFrom === 'receipt.block', '没有 extra 时用收据块号相减，结果相同')
  const p3 = mkProposal()
  for (const s of SENTINELS) p3.sentinels[s].receipt!.effectiveGasPrice = undefined
  ok(vetoMetrics(p3, SENTINELS)!.costWei === null, '收据缺 effectiveGasPrice 时成本为空（不补预设值）')
  const p4 = mkProposal()
  for (const s of SENTINELS) delete p4.sentinels[s].receipt
  ok(vetoMetrics(p4, SENTINELS) === null, '还没有 veto_receipt 时不出数字')
}
{
  const p = mkProposal()
  p.report = { text: '报告', done: false, open: true }
  ok(reportAutoVisible(p, '', 0, 8000), '报告串流中自动显示')
  p.report.done = true
  p.report.doneTs = 1000
  ok(reportAutoVisible(p, '', 8999, 8000) && !reportAutoVisible(p, '', 9000, 8000), '报告完成后 8 秒自动收起')
  ok(!reportAutoVisible(p, '1', 1000, 8000), '手动关掉后不再自动弹出')
}

// ---------- 2. 假事件播放器（?mode=fake）完整跑一次 ----------
startFake()
ok(!!store.deploy?.guardedAdmin, '假事件模式有 GuardedAdmin 地址（版位与测试网一致）')
playFake('evilMint')
const id1 = store.activeId!
const p1 = () => store.proposals.get(id1)!
ok(await until(() => SENTINELS.every((s) => p1().sentinels[s]?.receipt), 6000), '假事件：3 个哨兵都收到否决收据')
{
  const p = p1()
  const m = vetoMetrics(p, SENTINELS)!
  const fr = p.sentinels[m.who].receipt!
  ok(m.usedBlocks === fr.block! - p.proposeBlock! && m.waitBlocks === p.readyBlock! - fr.block!, `假事件：否决用了 ${m.usedBlocks} 块／还要等 ${m.waitBlocks} 块，与收据块号一致`)
  ok(m.usedBlocks + m.waitBlocks === 30, '假事件：两者相加＝冷静期 30 块')
  ok(m.costWei !== null && fmtMon(m.costWei) === '0.01256 MON', '假事件：成本来自收据 gasLimit × effectiveGasPrice')
}
ok(await until(() => p1().report.done, 9000), '假事件：AI 报告完成')
ok(reportAutoVisible(p1(), '', Date.now(), CONFIG.reportAutoCloseMs), '假事件：报告刚完成时仍显示')
ok(!reportAutoVisible(p1(), '', (p1().report.doneTs ?? 0) + CONFIG.reportAutoCloseMs, CONFIG.reportAutoCloseMs), '假事件：8 秒后自动收起')
ok(await until(() => !!p1().report.attachTx, 3000), '假事件：attachReason 交易哈希到位')
ok(await until(() => !!p1().execute, 12000), '假事件：冷静期满后 execute_attempt 到位')
ok(p1().execute?.result === 'reverted' && p1().execute?.error === 'ProposalVetoed', '假事件：execute 回 ProposalVetoed')
ok(!!p1().proposeTx, '假事件：提案交易哈希存在（driver /propose 回传）')

playFake('v2')
const id2 = store.activeId!
ok(id2 !== id1, '第二张卡成为当前提案')
ok(await until(() => SENTINELS.every((s) => store.proposals.get(id2)!.sentinels[s]?.verdict === 'pass'), 6000), '假事件：v2 三个哨兵放行')
ok(vetoMetrics(store.proposals.get(id2)!, SENTINELS) === null, '放行不产生否决数字')

// ---------- 3. 新规则与未知事件类型 ----------
ok(RULE_TEXT.R3B_THIRD_PARTY_FUNDS?.length > 0 && RULE_TEXT.R9_NEW_OPCODES?.length > 0, '新规则 R3B／R9 有中文说明')
{
  const n0 = store.stream.length
  let threw = false
  try {
    store.ingest({ v: 1, type: 'veto_failed', ts: Date.now(), mode: 'testnet', source: 'sentinel-2', id: id1, error: 'nonce too low', txHash: TX })
    store.ingest({ v: 1, type: 'totally_new_type', ts: Date.now() + 1, mode: 'testnet', source: 'sentinel-3' } as never)
    store.ingest({ v: 1, type: 'veto_failed', ts: Date.now() + 2, mode: 'testnet', source: 'sentinel-2', id: 'no-such-proposal', extra: { x: 1 } })
  } catch {
    threw = true
  }
  ok(!threw, '未知事件类型不会让页面出错')
  const tail = store.stream.slice(n0)
  ok(tail.some((l) => l.type === 'veto_failed' && l.text.includes('否决交易失败') && l.text.includes('nonce too low')), 'veto_failed 出现在事件串流（含错误讯息）')
  ok(tail.some((l) => l.type === 'totally_new_type' && l.text.includes('未知事件')), '没有 id 的未知事件也列进事件串流')
  ok(tail.filter((l) => l.type === 'veto_failed').length === 2, '同类未知事件不会被去重吞掉')
  ok(store.proposals.get(id1)!.sentinels['sentinel-2']?.receipt !== undefined, '未知事件不改动提案状态')
}

// ---------- 4. 多语系（zh-CN／zh-TW／en） ----------
{
  const dom = installDom()
  const CJK = /[㐀-鿿　-〿＀-￯]/
  // 简体专用字（繁体不会出现）：拿来抓 zh-TW 漏翻
  const SIMPLIFIED_ONLY = /[区块链测试网报这个为发时间实现评题机连线执务应总转账没权变态错误载读据击两导点让说计规则节预开关显设证资产处数长额签码详图际断续单传备换认话该调钥钱闭难页验类给满离线异议级]/
  // 报告正文（reporter 原文，不翻）与语言钮（简/繁/EN 本来就是各语言自己的字）不算
  const strip = (h: string) => h.replace(/<div class="r-body[^"]*"><div>[\s\S]*?<\/div><\/div>/g, '').replace(/<button data-lang[^>]*>[\s\S]*?<\/button>/g, '')
  const plain = (h: string) => strip(h).replace(/<[^>]+>/g, ' ')
  const missing = (words: string[], text: string) => words.filter((w) => !text.includes(w))
  const lack = (words: string[], text: string) => {
    const m = missing(words, text)
    return m.length ? `（缺：${m.join('、')}）` : ''
  }

  // 字典本身：en 不含中文字元，zh-TW 不含简体专用字（含 chain 模式才会出现的句子）
  const enLeak = Object.entries(DICT.en).filter(([, v]) => CJK.test(v))
  ok(enLeak.length === 0, `en 字典没有中文字元${enLeak.length ? '：' + enLeak.slice(0, 3).map(([k]) => k).join(', ') : ''}`)
  const twLeak = Object.entries(DICT['zh-TW']).filter(([, v]) => SIMPLIFIED_ONLY.test(v))
  ok(twLeak.length === 0, `zh-TW 字典没有简体专用字${twLeak.length ? '：' + twLeak.slice(0, 3).map(([k, v]) => `${k}=${v}`).join(', ') : ''}`)
  const zhKeys = Object.keys(DICT['zh-CN'])
  const mayBeEmpty = new Set(['tb.recent']) // en 省掉「最近提案：」标签，五颗钮才排得进一行
  ok(LANGS.every((l) => zhKeys.every((k) => typeof DICT[l][k] === 'string' && (DICT[l][k].length > 0 || mayBeEmpty.has(k)))), '三种语言的字典 key 一样齐（含规则、种类、卡片、阶段、状态）')
  ok(['R1_TOTAL_SUPPLY', 'R2_OWNER', 'R3_TRANSFER_CONSERVATION', 'R3B_THIRD_PARTY_FUNDS', 'R9_NEW_OPCODES'].every((r) => LANGS.every((l) => !!DICT[l][`rule.${r}`])), '规则 R1–R9／R3B 三种语言都有说明')

  // 选语言：?lang= 优先，其次 localStorage，默认 zh-CN
  const loc = globalThis.location as unknown as { search: string }
  const search0 = loc.search
  loc.search = '?mode=fake'
  ok(initLang() === 'zh-CN', '默认 zh-CN')
  dom.mem.set('eleven.lang', 'zh-TW')
  ok(initLang() === 'zh-TW', 'localStorage 记住上次的语言')
  loc.search = '?mode=fake&lang=en'
  ok(initLang() === 'en', '?lang=en 优先于 localStorage')
  loc.search = '?mode=fake&lang=xx'
  ok(initLang() === 'zh-TW', '不认识的 ?lang= 退回 localStorage')
  loc.search = search0
  dom.mem.clear()
  setLang('zh-CN', false)

  // 画面需要的状态：离线哨兵、main.ts 写的中文句子（评委状态与 driver 串流）
  toggleFakeOffline('sentinel-3')
  await sleep(CONFIG.heartbeatTimeoutMs + 300)
  judge.status = '已送出（假事件）。判定后翻牌。'
  store.log('driver', 'propose', '送出提案 #9（EvilMint） tx 0x12345678…', 'info')
  const nProps = store.proposals.size
  const nLines = store.stream.length
  const screens = (): string => {
    let all = ''
    for (const id of [id1, id2]) {
      store.activeId = id
      ui.judgeOpen = true
      ui.tableOpen = true
      ui.reportOpen = true
      render()
      all += dom.html()
      ui.judgeOpen = ui.tableOpen = ui.reportOpen = false
      ui.reportDismissedFor = id
      render()
      all += dom.html()
    }
    return all
  }
  // 串流句子（画面只显示最后 4 行，所以直接拿 store.stream 里的模板来套）
  const simLine = store.stream.find((l) => l.type === 'sim_result' && l.text.includes(`#${id1}`))!
  const failLine = store.stream.find((l) => l.type === 'veto_failed')!
  const lineIn = {} as Record<Lang, string>
  const out = {} as Record<Lang, string>
  for (const l of LANGS) {
    setLang(l, false)
    out[l] = screens()
    lineIn[l] = [simLine, failLine].map((x) => (x.msg ? tm(x.msg) : x.text)).join('\n')
  }
  ok(store.proposals.size === nProps && store.stream.length === nLines, '切换语言不丢提案、不丢事件串流')
  ok(lang() === 'en' && dom.doc.title === 'Eleven Seconds · War Room' && dom.doc.documentElement.lang === 'en', 'document.title 与 <html lang> 跟着语言走')

  const cn = plain(out['zh-CN'])
  const cnWords = ['否决', '当前区块', '冷静期', '哨兵 1', '事件串流', '评委出题', '同样等 30 个区块', '陌生地址改变了总供应量']
  ok(missing(cnWords, cn).length === 0, `zh-CN 维持原有文字（否决／当前区块／冷静期…）${lack(cnWords, cn)}`)
  ok(simLine.msg !== undefined && lineIn['zh-CN'] === `${simLine.text}\n${failLine.text}`, 'zh-CN 串流句子套模板后与原文一字不差')

  const tw = plain(out['zh-TW'])
  const twWords = ['否決', '目前區塊', '冷靜期', '評審出題', '事件串流', '陌生地址改變了總供應量', '已送出（假事件）。判定後翻牌。', '送出提案 #9（EvilMint）']
  ok(missing(twWords, tw).length === 0, `zh-TW 关键字串（否決／區塊／評審…）${lack(twWords, tw)}`)
  ok(lineIn['zh-TW'].includes(`判定否決 #${id1}：R1_TOTAL_SUPPLY（模擬`) && lineIn['zh-TW'].includes('否決交易失敗：'), 'zh-TW 串流句子套模板')
  const twBad = [...new Set(tw.match(new RegExp(SIMPLIFIED_ONLY.source, 'g')) ?? [])]
  ok(twBad.length === 0, `zh-TW 画面没有简体专用字${twBad.length ? '：' + twBad.join('') : ''}`)

  const en = plain(out.en)
  const enWords = ['Veto', 'blocks', 'Attacker', 'Sentinel 1', 'Event stream', 'Judge picks a card', 'The same 30-block wait', 'Cooldown', 'OFFLINE', 'stranger changed total supply']
  ok(missing(enWords, en).length === 0, `en 关键字串（Veto／blocks／Attacker…）${lack(enWords, en)}`)
  ok(lineIn.en.includes(`Veto #${id1}: R1_TOTAL_SUPPLY (sim`) && lineIn.en.includes('Veto tx failed: #') && !CJK.test(lineIn.en.replace('nonce too low', '')), 'en 的 store 句子与未知事件都套了模板')
  ok(en.includes('Sent (simulated). The card flips after the verdict.') && en.includes('Proposal #9 sent (EvilMint)'), 'en 也翻了 main.ts 写的句子（评委状态、driver 串流）')
  const enBad = [...new Set(en.match(new RegExp(CJK.source, 'g')) ?? [])]
  ok(enBad.length === 0, `en 画面没有中文字元（报告正文除外）${enBad.length ? '：' + enBad.join('') : ''}`)
  ok(/<button data-lang[^>]*>[\s\S]*简[\s\S]*繁[\s\S]*EN/.test(out.en) && Object.values(LANG_LABEL).join('/') === '简/繁/EN', '工具列有「简 / 繁 / EN」切换钮')
  ok(/class="r-body"><div>[^<]*[一-鿿]/.test(out.en) && out.en.includes('original: Chinese'), 'en 下报告正文维持原文，旁边标示原文语言')
  setLang('zh-CN', false)
}

// ---------- 5. chain 模式：链上真实事件自动回放（replay.ts 纯函数＋控制器） ----------
{
  const H = (n: number) => '0x' + n.toString(16).padStart(64, '0')
  const rc = (block: number) => ({ txHash: H(block), block, status: 'success', gasUsed: '123112', gasLimit: '123112', effectiveGasPrice: '102000000000', latencyMs: null })
  // 被否决的攻击：提案块 71719034、readyBlock 71719064，三个 guardian 依序在 +9／+10／+11 块否决
  const atk: Proposal = {
    id: '7', kind: '0', target: '0xabc', codehash: '0x01', proposeBlock: 71719034, readyBlock: 71719064, firstTs: 0, proposeTx: H(1),
    sentinels: {
      'sentinel-2': { verdict: 'veto', rule: 'R1_TOTAL_SUPPLY', vetoTx: H(71719044), receipt: rc(71719044) },
      'sentinel-1': { verdict: 'veto', rule: 'R1_TOTAL_SUPPLY', vetoTx: H(71719043), receipt: rc(71719043) },
      'sentinel-3': { verdict: 'veto', rule: 'R1_TOTAL_SUPPLY', vetoTx: H(71719045), receipt: rc(71719045) },
    },
    report: { text: '', done: false, open: false, attachTx: H(9), reportHash: H(10), attachBlock: 71719050 },
    chain: { status: 2, statusName: 'Vetoed', vetoCount: 3, proposer: '0x1', readTs: 0 },
  }
  // 已执行的 v2：提案块 71719100、readyBlock 71719130、Executed 在 71719142
  const v2: Proposal = {
    id: '8', kind: '0', target: '0xdef', codehash: '0x02', proposeBlock: 71719100, readyBlock: 71719130, firstTs: 0, proposeTx: H(2),
    sentinels: { 'sentinel-1': {}, 'sentinel-2': {}, 'sentinel-3': {} },
    execute: { txHash: H(71719142), result: 'success', error: null, ts: 0, block: 71719142 },
    report: { text: '', done: false, open: false },
    chain: { status: 3, statusName: 'Executed', vetoCount: 0, proposer: '0x1', readTs: 0 },
  }
  const older: Proposal = { ...atk, id: '3', proposeBlock: 71710000, readyBlock: 71710030 }
  const pending: Proposal = { ...v2, id: '9', chain: { ...v2.chain!, status: 1 }, execute: undefined }

  const tl = buildTimeline(atk)!
  const kinds = tl.steps.map((x) => x.kind + (x.sentinel ? ':' + x.sentinel.split('-')[1] : '')).join(',')
  ok(kinds === 'proposed,veto:1,veto:2,veto:3,reason,ready', `回放：攻击时间轴事件顺序 ${kinds}`)
  ok(tl.type === 'attack' && tl.start === 71719032 && tl.end === 71719067, `回放：虚拟时钟从提案前 2 块（${tl.start}）到 readyBlock+3（${tl.end}）`)
  const offs = tl.steps.filter((x) => x.kind === 'veto').map((x) => x.block - tl.proposeBlock)
  ok(offs.join('/') === '9/10/11', `回放：否决区块偏移 ${offs.join('/')}（期望 9/10/11，取自收据块号）`)
  const before = snapshotAt(atk, tl, 71719042)
  ok(before.chain?.status === 1 && vetoMetrics(before, SENTINELS) === null && !before.report.attachTx, '回放：第一笔否决之前是冷静期中、大字指标不出数字')
  const first = snapshotAt(atk, tl, 71719043)
  const fm = vetoMetrics(first, SENTINELS)
  ok(first.chain?.status === 2 && first.chain.vetoCount === 1 && fm?.usedBlocks === 9 && fm.waitBlocks === 21 && fm.costWei !== null && fmtMon(fm.costWei) === '0.01256 MON', '回放：第一笔否决出现才显示真实值（9 块／21 块／0.01256 MON）')
  ok(snapshotAt(atk, tl, 71719045).chain?.vetoCount === 3 && snapshotAt(atk, tl, 71719050).report.attachTx === H(9), '回放：三票依序亮起、ReasonAttached 在它的区块出现')
  ok(snapshotAt(atk, tl, 71719033).chain === undefined && snapshotAt(atk, tl, 71719033).proposeTx === undefined, '回放：提案块之前还没有链上状态')
  ok(replayStage(71719043, 71719043) === 0 && replayStage(71719043, 71719045) === 2 && replayStage(71719043, 71719090) === 3 && replayStage(71719043, 71719042) === -1, '回放：四段状态条随虚拟区块依序点亮')

  const tv = buildTimeline(v2)!
  ok(tv.type === 'v2' && tv.steps.map((x) => x.kind).join(',') === 'proposed,ready,executed' && tv.end === 71719145, `回放：v2 时间轴 proposed→ready→executed，终点延到 Executed+3（${tv.end}）`)
  const v2a = snapshotAt(v2, tv, 71719141)
  const v2b = snapshotAt(v2, tv, 71719142)
  ok(!v2a.execute && v2a.chain?.status === 1 && SENTINELS.every((s) => v2a.sentinels[s].verdict === 'pass'), '回放：v2 冷静期满后哨兵未否决、Executed 前还没生效')
  ok(v2b.execute?.txHash === H(71719142) && v2b.chain?.status === 3, '回放：v2 到 Executed 区块显示已生效与 Executed tx')
  ok(buildTimeline(pending) === null && buildTimeline({ ...atk, chain: { ...atk.chain!, status: 1 } }) === null, '回放：还在冷静期／没有真实结果的提案不回放')
  const pick = pickReplay([older, atk, v2, pending])
  ok(pick.attack?.id === '7' && pick.v2?.id === '8', '回放：挑最近一个被否决的攻击与最近一个已执行的 v2')
  ok(pickReplay([older]).v2 === null, '回放：找不到 v2 时只有攻击')

  // 控制器：8 秒触发、轮流播放、每段停 4 秒、即时事件打断、闲置 60 秒再回放、P 键暂停
  const logged: string[] = []
  const r = new AutoReplay(0, (t: Timeline, st: TLStep) => logged.push(`${t.id}:${st.kind}`))
  const props = new Map([atk, v2].map((p) => [p.id, p]))
  const ctx = (o: Partial<{ busy: boolean; reduced: boolean }> = {}) => ({ proposals: props.values(), get: (id: string) => props.get(id), blockMs: 300, reduced: !!o.reduced, liveBusy: !!o.busy })
  const get = (id: string) => props.get(id)
  r.tick(REPLAY.firstDelayMs - 1, ctx())
  ok(!r.active, '回放：开页 8 秒内不开始')
  r.tick(REPLAY.firstDelayMs, ctx())
  ok(r.active && r.frame(REPLAY.firstDelayMs, get)?.tl.id === '7' && r.frame(REPLAY.firstDelayMs, get)?.vblock === 71719032, '回放：8 秒没有即时事件就从攻击开始，起点是提案前 2 块')
  const t9 = REPLAY.firstDelayMs + 11 * 300
  r.tick(t9, ctx())
  ok(r.frame(t9, get)?.vblock === 71719043 && logged.join(',') === '7:proposed,7:veto', `回放：按 0.3 秒/块推进，第 11 块时已播 ${logged.join(',')}`)
  const segMs = (tl.end - tl.start) * 300
  r.tick(REPLAY.firstDelayMs + segMs + 10, ctx())
  ok(r.frame(REPLAY.firstDelayMs + segMs + 10, get)?.hold === true && r.frame(REPLAY.firstDelayMs + segMs + 10, get)?.tl.id === '7', '回放：播到终点后停在最终状态')
  const tNext = REPLAY.firstDelayMs + segMs + REPLAY.gapMs
  r.tick(tNext, ctx())
  ok(r.frame(tNext, get)?.tl.id === '8', '回放：停 4 秒后轮到 v2')
  // 即时事件打断
  const tLive = tNext + 1000
  r.onLive(tLive)
  ok(!r.active && r.frame(tLive, get) === null, '回放：收到即时事件立刻停止回放')
  r.tick(tLive + REPLAY.idleMs - 1, ctx())
  ok(!r.active, '回放：距离上一次即时事件不到 60 秒不再回放')
  r.tick(tLive + REPLAY.idleMs, ctx())
  ok(r.active && r.frame(tLive + REPLAY.idleMs, get)?.tl.id === '7', '回放：闲置 60 秒后从攻击重新回放')
  r.tick(tLive + REPLAY.idleMs + 100, ctx({ busy: true }))
  ok(!r.active, '回放：有即时提案在冷静期中就让位给即时画面')
  // 暂停／继续
  const tp = tLive + REPLAY.idleMs + 200
  r.tick(tp, ctx())
  const fz = r.frame(tp + 900, get)?.vblock
  r.toggle(tp + 900)
  r.tick(tp + 5000, ctx())
  ok(r.paused && r.frame(tp + 5000, get)?.vblock === fz && r.frame(tp + 5000, get)?.paused === true, '回放：暂停时冻结在当下的回放区块')
  r.toggle(tp + 5000)
  ok(!r.paused && r.frame(tp + 5000 + 300, get)!.vblock === fz! + 1, '回放：继续后从冻结处接着播')
  // prefers-reduced-motion：直接最终状态
  const rr = new AutoReplay(0)
  rr.tick(REPLAY.firstDelayMs, ctx({ reduced: true }))
  ok(rr.frame(REPLAY.firstDelayMs, get)?.vblock === tl.end && rr.frame(REPLAY.firstDelayMs, get)?.p.chain?.status === 2, 'prefers-reduced-motion：直接显示每段的最终状态')
}

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exit(fails ? 1 : 0)
