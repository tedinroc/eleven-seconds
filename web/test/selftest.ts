// 前端逻辑自测（不开浏览器）：在 Node 里跑 ?mode=fake 的假事件播放器，检查画面要用的实测值。
//   npm run selftest
import './stub'
import { CONFIG } from '../src/config'
import { blockFontPx, explorerUrl, fmtGwei, fmtMon, plausibleBlockMs, reportAutoVisible, vetoMetrics } from '../src/derive'
import { playFake, startFake } from '../src/fake'
import { SENTINELS } from '../src/runtime'
import { store, type Proposal } from '../src/store'

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

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exit(fails ? 1 : 0)
