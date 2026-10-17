// 战情室画面（1280×720 固定舞台，按视窗等比缩放）。
// 每个区块只在内容变化时才重写 innerHTML，翻牌动画只播一次。
import { blocks, STAGE_CN } from './chain'
import { CONFIG } from './config'
import { blockFontPx, explorerUrl, fmtGwei, fmtMon, plausibleBlockMs, reportAutoVisible, vetoMetrics } from './derive'
import { CARD_GUARDIAN, chainHealth, recentIds, STATUS_CN } from './chainwatch'
import { CHAIN, HAS_COMMIT_STATE, LOCAL_TAG, MODE, ON_TESTNET, READ_ONLY, SENTINELS } from './runtime'
import { short, store, type Proposal, type SentinelOnProposal } from './store'
import { CARDS, KIND_TEXT, RULE_TEXT, type CardId, type CardInfo } from './types'

const $ = (id: string) => document.getElementById(id)!
const prev = new Map<string, string>()
function patch(id: string, html: string): boolean {
  if (prev.get(id) === html) return false
  prev.set(id, html)
  $(id).innerHTML = html
  return true
}

/** 面板内容超出可用高度时，把内层 .fit 整块等比缩小（CSS zoom，下限 min），放得下就还原。
 *  只是安全网：正常文案在 1280×720 舞台上本来就放得下（见 style.css 的行高预算）。 */
function autoFit(boxId: string, min = 0.85) {
  const box = $(boxId)
  const inner = box.querySelector<HTMLElement>(':scope > .fit')
  if (!inner) return
  inner.style.removeProperty('zoom')
  const cs = getComputedStyle(box)
  const avail = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
  const need = inner.offsetHeight
  if (need <= avail + 0.5) return
  const z = Math.max(min, Math.floor((avail / need) * 1000) / 1000)
  inner.style.setProperty('zoom', String(z))
}

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

const tag = () => (LOCAL_TAG ? `<span class="loc">${LOCAL_TAG}</span>` : '')

/** 测试网模式才连到浏览器（假事件的哈希是编的，本机没有浏览器） */
function linkTo(base: string | null, v: string | undefined | null, n: number, cls = 'mono'): string {
  if (!v) return '—'
  const url = ON_TESTNET ? explorerUrl(base, v) : null
  if (url) return `<a class="${cls} xl" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(v)}">${esc(short(v, n))}<span class="xl-i">↗</span></a>`
  return `<span class="${cls}" title="${esc(v)}">${esc(short(v, n))}</span>`
}
const txLink = (h: string | undefined | null, n = 6) => linkTo(CHAIN.explorerTx, h, n)
const addrLink = (a: string | undefined | null, n = 6) => linkTo(CHAIN.explorerAddr, a, n)

/** Sourcify 徽章：只在查验确认后显示；未验证的（攻击实现）明说「未开源」 */
function verifyChip(addr: string | undefined | null, showNo = false): string {
  if (!addr || !ON_TESTNET) return ''
  const st = store.verified.get(addr.toLowerCase())
  if (st === 'yes') return `<span class="vchip yes" title="Sourcify exact match">✓ 已验证</span>`
  if (st === 'no' && showNo) return `<span class="vchip no" title="Sourcify 查无原始码">未开源</span>`
  return ''
}

export function mountSkeleton() {
  $('app').innerHTML = `
  <div id="stage">
    <header id="top">
      <div class="top-left">
        <div class="badge-row"><span id="badge"></span><span id="ga" class="ga"></span></div>
        <div class="title">十一秒 <span>Eleven Seconds · 升级冷静期＋哨兵否决</span></div>
        <div id="link" class="link"></div>
      </div>
      <div id="toolbar" class="toolbar"></div>
      <div class="top-right">
        <div class="blk-meta"><span class="blk-label">当前区块 <span id="blk-tag"></span></span><span id="bt" class="bt"></span></div>
        <div id="blk" class="blk">—</div>
      </div>
    </header>
    <main>
      <section id="attacker" class="panel">
        <div class="fit">
          <h2><span class="ico">☠</span> 攻击者 <small>用被盗的 admin 钥匙提案升级</small></h2>
          <div id="pcard"></div>
          <div id="pbar"></div>
          <div id="countdown"></div>
          <div id="exec"></div>
        </div>
      </section>
      <section id="sentinels" class="panel">
        <h2><span class="ico">⛨</span> 哨兵 <small>3 个独立进程 · 各自的钥匙 · eth_simulateV1</small></h2>
        ${SENTINELS.map((s) => `<div id="s-${s}" class="scard"></div>`).join('')}
      </section>
    </main>
    <section id="metrics"></section>
    <section id="stream"></section>
    <div id="ov-report" class="dock hidden"></div>
    <div id="ov-judge" class="overlay hidden"></div>
    <div id="ov-table" class="overlay hidden"></div>
  </div>`
  fitStage()
  window.addEventListener('resize', fitStage)
}

function fitStage() {
  const s = Math.min(window.innerWidth / 1280, window.innerHeight / 720)
  const el = $('stage')
  el.style.transform = `scale(${s})`
  el.style.left = `${Math.max(0, (window.innerWidth - 1280 * s) / 2)}px`
  el.style.top = `${Math.max(0, (window.innerHeight - 720 * s) / 2)}px`
}

// ---------- 顶部 ----------
/** 右上角栏位宽度（与 style.css #top 第三栏一致）与区块数字最大字号 */
const BLK_WIDTH = 396
const BLK_MAX_PX = 84
function renderTop() {
  const badge =
    MODE === 'testnet' || MODE === 'chain'
      ? `<span class="badge live${READ_ONLY ? ' chain' : ''}">● ${esc(CHAIN.badge)}</span>`
      : MODE === 'replay'
        ? `<span class="badge grey">⟲ 本机重演</span>`
        : `<span class="badge grey dashed">▶ 假事件演示</span>`
  patch('badge', badge)
  const linkText =
    blocks.link === 'ws'
      ? `WS 订阅 ${HAS_COMMIT_STATE ? 'monadNewHeads' : 'newHeads'}`
      : blocks.link === 'poll'
        ? `⚠ WS 断线，轮询 ${CONFIG.pollMs}ms`
        : blocks.link === 'fake'
          ? '内建假事件播放器'
          : '✕ 链连线中断'
  patch('link', esc(READ_ONLY ? `${linkText} · log ${chainHealth.logsLink === 'ws' ? 'WS 订阅' : chainHealth.logsLink === 'poll' ? `eth_getLogs 游标 #${chainHealth.cursor || '…'}` : '连线中…'}` : linkText))
  // 守门合约地址（driver /deployments 提供；测试网可点、Sourcify 查验后加徽章）
  const ga = store.deploy?.guardedAdmin
  patch('ga', ga ? `<span class="ga-l" title="GuardedAdmin">守门合约 ${verifyChip(ga)}</span><span class="ga-a">${addrLink(ga, 6)} ${tag()}</span>` : '')
  const blkText = blocks.latest ? `#${blocks.latest.toLocaleString('en-US')}` : '—'
  if (prev.get('blk') !== blkText) $('blk').style.fontSize = `${blockFontPx(blkText, BLK_WIDTH, BLK_MAX_PX)}px`
  patch('blk', blkText)
  patch('blk-tag', tag())
  const raw = blocks.blockTimeMs()
  const bt = plausibleBlockMs(raw, CONFIG.minPlausibleBlockMs)
  patch('bt', bt ? `· 实测 ${(bt / 1000).toFixed(2)} 秒/块` : raw !== null ? '· 快进挖块中，不计秒/块' : '· 测量出块时间中…')
  if (READ_ONLY) {
    const ids = recentIds()
    const chips = ids
      .map((id) => {
        const p = store.proposals.get(id)!
        const st = p.chain?.status
        const cls = st === 2 ? 'bad' : st === 3 ? 'good' : ''
        return `<button data-act="sel:${esc(id)}" class="${store.activeId === id ? 'on' : ''}"><b class="${cls}">#${esc(id)}</b> ${esc(st !== undefined ? STATUS_CN[st] ?? '' : '…')}</button>`
      })
      .join('')
    patch(
      'toolbar',
      `<span class="ro">现场由操作者触发；本页只读</span><button data-act="table">T 30 块对照</button><button data-act="report">R 报告哈希</button>` +
        (ids.length ? `<span class="hint">最近提案：${chips}</span>` : `<span class="hint">${chainHealth.loadedRecent ? '链上还没有提案' : '正在从链上载入最近 5 个提案…'}</span>`),
    )
    return
  }
  patch(
    'toolbar',
    `<button data-act="judge">J 评委出题</button><button data-act="table">T 30 块对照</button><button data-act="report">R AI 报告</button>` +
      (MODE === 'fake' ? `<button data-act="kill">K 哨兵 3 离线</button>` : `<button data-act="approve">A 核准 v2</button>`) +
      `<span class="hint">直接提案：<button data-act="p:evilMint">1 增发</button><button data-act="p:evilOwner">2 夺权</button><button data-act="p:evilFee">3 抽成</button><button data-act="p:v2">4 v2</button></span>`,
  )
}

// ---------- 四段状态条 ----------
function stageBar(block: number | null | undefined, floor = -1): string {
  if (!block) return `<div class="bar"><span class="seg off">○ 等待上链</span></div>`
  if (!HAS_COMMIT_STATE) {
    const ok = blocks.latest >= block
    return `<div class="bar grey"><span class="seg ${ok ? 'on' : 'off'}">${ok ? '■ 已出块' : '○ 等待出块'} #${block}</span><span class="seg note">本机没有 Proposed→Verified 阶段</span></div>`
  }
  const st = Math.max(blocks.stageOf(block), floor)
  return `<div class="bar">${STAGE_CN.map((name, i) => {
    const cls = i <= st ? 'on' : i === st + 1 ? 'next' : 'off'
    const ico = i <= st ? '✓' : '○'
    return `<span class="seg ${cls} st${i}">${ico} ${name}</span>`
  }).join('')}</div>`
}

// ---------- 攻击者 ----------
function cardOf(p: Proposal): CardInfo | null {
  const id = p.card ?? (store.implNames.get(p.target.toLowerCase()) as CardId | undefined)
  return CARDS.find((c) => c.id === id) ?? null
}

function verdictOf(p: Proposal): { verdict: 'pass' | 'veto' | null; rule: string | null } {
  let pass = false
  for (const s of SENTINELS) {
    const sp = p.sentinels[s]
    if (sp?.verdict === 'veto') return { verdict: 'veto', rule: sp.rule ?? null }
    if (sp?.verdict === 'pass') pass = true
  }
  return { verdict: pass ? 'pass' : null, rule: null }
}

function revealed(p: Proposal): boolean {
  if (!p.judge) return true
  return verdictOf(p).verdict !== null || !!p.execute
}

function miniCard(p: Proposal): string {
  const c = cardOf(p)
  if (!revealed(p)) return `<div class="mini back"><div>?</div><small>评委蒙牌</small></div>`
  if (!c) return `<div class="mini front unknown"><div>未知实现</div><small>只看 bytecode</small></div>`
  const v = verdictOf(p)
  const match = v.verdict === null ? '' : v.verdict === c.expect ? '<b class="good">✓ 判定符合</b>' : '<b class="bad">✕ 判定不符</b>'
  return `<div class="mini front ${p.judge ? 'flip' : ''} ${c.expect}"><div>${esc(c.name)}</div><small>${esc(c.desc)}</small>${match}</div>`
}

function renderAttacker(p: Proposal | null) {
  if (!p) {
    patch('pcard', READ_ONLY ? `<div class="empty">${chainHealth.loadedRecent ? '链上还没有提案' : '正在读取链上提案…'}<br><small>现场提案由操作者触发；本页从 Monad 测试网直接读取</small></div>` : `<div class="empty">等待提案…<br><small>按 J 请评委出题，或按 1–4 直接提案</small></div>`)
    patch('pbar', '')
    patch('countdown', '')
    patch('exec', '')
    return
  }
  const kind = KIND_TEXT[p.kind] ?? `kind ${p.kind}`
  const c = cardOf(p)
  const showName = revealed(p) && c
  patch(
    'pcard',
    `<div class="pc">
      <div class="pc-main">
        <div class="pc-title">提案 #${esc(p.id)} · ${esc(kind)}${p.dropped ? ' <span class="bad">⚠ log 已消失</span>' : ''}${p.chain ? ` <span class="chainst s${p.chain.status}">链上 ${esc(STATUS_CN[p.chain.status] ?? p.chain.statusName)}</span>` : ''}</div>
        <div class="pc-row">新实现 ${addrLink(p.target, 8)}${showName ? ` <b>${esc(c!.name)}</b>` : ''}${revealed(p) ? ` ${verifyChip(p.target, true)}` : ''}</div>
        <div class="pc-row">codehash <span class="mono">${esc(short(p.codehash, 8))}</span></div>
        <div class="pc-row">提案块 <b>#${p.proposeBlock ?? '?'}</b> → 可执行块 <b>#${p.readyBlock ?? '?'}</b> ${tag()}</div>
      </div>
      <div class="pc-mini" id="mini-${esc(p.id)}">${miniCard(p)}</div>
    </div>`,
  )
  patch('pbar', `<div class="barlabel">提案交易 ${txLink(p.proposeTx)}</div>${stageBar(p.proposeBlock)}`)

  const v = verdictOf(p)
  let cd = ''
  if (p.readyBlock && p.proposeBlock) {
    const total = Math.max(1, p.readyBlock - p.proposeBlock)
    const left = Math.max(0, p.readyBlock - blocks.latest)
    const pct = Math.min(100, Math.round(((total - left) / total) * 100))
    const head =
      left > 0
        ? `冷静期还剩 <b class="big">${left}</b> 块`
        : `冷静期已满（${total} 块）`
    const sub =
      v.verdict === 'veto' || p.chain?.status === 2
        ? '<span class="bad">✕ 已被否决：时间到了也执行不了</span>'
        : v.verdict === 'pass'
          ? READ_ONLY
            ? '<span class="good">✓ 冷静期内链上没有任何 Vetoed</span>'
            : '<span class="good">✓ 哨兵放行：期满自动执行</span>'
          : READ_ONLY
            ? '<span>⏳ 冷静期中，链上还没有否决</span>'
            : '<span>⏳ 哨兵判定中…</span>'
    cd = `<div class="cd"><div class="cd-head">${head} ${tag()}</div><div class="prog"><i style="width:${pct}%"></i></div><div class="cd-sub">${sub}</div></div>`
  }
  patch('countdown', cd)

  let ex = ''
  if (READ_ONLY && !p.execute) {
    const st = p.chain?.status
    ex =
      st === 2
        ? `<div class="exec bad"><span>✕ 链上 Vetoed：execute 只会回滚 <b>ProposalVetoed</b></span><span class="sub">getProposal(${esc(p.id)}).vetoCount = ${p.chain!.vetoCount}</span></div>`
        : st === 3
          ? `<div class="exec good"><span>✓ 链上 Executed：新实现已生效</span><span class="sub">Executed 事件不在提案后 100 块内，没有交易连结</span></div>`
          : p.readyBlock && blocks.latest >= p.readyBlock
            ? `<div class="exec wait">冷静期已满，等操作者送 execute（block.number ≥ ${p.readyBlock}）</div>`
            : `<div class="exec wait">execute：冷静期满才能送（block.number ≥ ${p.readyBlock ?? '?'}）</div>`
    patch('exec', ex)
    return
  }
  if (p.execute) {
    if (p.execute.result === 'success') {
      const ver = p.execute.extra?.version
      ex = `<div class="exec good"><span>✓ execute 成功：已生效 ${c?.id === 'v2' || ver === '2' ? 'v2' : '新实现'}${ver !== undefined && ver !== null ? ` · version() = "${esc(ver)}"` : ''}</span><span class="sub">tx ${txLink(p.execute.txHash)}</span></div>`
    } else {
      ex = `<div class="exec bad"><span>✕ execute 回滚：<b>${esc(p.execute.error ?? '未知错误')}</b></span><span class="sub">revert 交易 ${txLink(p.execute.txHash)} 已上链</span></div>`
    }
  } else if (p.readyBlock && blocks.latest >= p.readyBlock) {
    ex = `<div class="exec wait">⏳ 冷静期满，driver 正在 execute…</div>`
  } else {
    ex = `<div class="exec wait">execute：冷静期满才能送（block.number ≥ ${p.readyBlock ?? '?'}）</div>`
  }
  patch('exec', ex)
}

let attackerKey = ''
/** 攻击者面板四块任一有变才重新量高度（避免每帧强制排版） */
function attackerDirty(): boolean {
  const k = ['pcard', 'pbar', 'countdown', 'exec'].map((id) => prev.get(id) ?? '').join('\u0000')
  if (k === attackerKey) return false
  attackerKey = k
  return true
}

// ---------- 哨兵 ----------
function vetoStage(sp: SentinelOnProposal): number {
  return sp.finalizedBlock ? 2 : -1
}

/** chain 模式的哨兵卡：没有心跳可看，只显示 guardian 地址与它在链上做了什么 */
function renderSentinelChain(s: string, p: Proposal | null) {
  const n = s.split('-')[1]
  const g = CARD_GUARDIAN.get(s)
  let verdict = '<span class="dim">○ 链上没有动作</span>'
  let veto = ''
  const sp = p?.sentinels[s]
  if (p && sp) {
    if (sp.verdict === 'veto') {
      const r = sp.rule ?? '?'
      const rc = sp.receipt
      const used = rc?.block && p.proposeBlock ? rc.block - p.proposeBlock : null
      verdict = `<span class="bad">✕ 否决</span> <b>${esc(r.split('_')[0])}</b> ${esc(RULE_TEXT[r] ?? r)}`
      veto = `<div class="barlabel">Vetoed ${txLink(sp.vetoTx)} · 块 #${rc?.block ?? '?'}${used !== null ? ` · 提案后第 <b>${used}</b> 块` : ''}</div>${stageBar(rc?.block ?? null)}`
    } else if (sp.verdict === 'pass') {
      verdict = `<span class="good">✓ 未否决</span> 冷静期内这个 guardian 没有送 Vetoed`
      veto = `<div class="barlabel dim">放行不发任何交易</div>`
    } else if (p.chain?.status === 2) {
      verdict = `<span class="dim">— 未送否决（已被其他哨兵否决）</span>`
    } else if (p.chain?.status === 1) {
      verdict = `<span class="warn">⏳ 冷静期中</span> 链上还没有这个 guardian 的 Vetoed`
    }
  }
  patch(
    `s-${s}`,
    `<div class="scard-in">
      <div class="s-head"><b>哨兵 ${n}</b> <span class="chip on">guardian</span> <span class="dim">${addrLink(g, 4)}</span></div>
      <div class="s-verdict">${verdict}</div>
      <div class="s-veto">${veto}</div>
    </div>`,
  )
}

function renderSentinel(s: string, p: Proposal | null, now: number) {
  if (READ_ONLY) return renderSentinelChain(s, p)
  const h = store.health.get(s)
  const online = store.isOnline(s, now)
  const n = s.split('-')[1]
  const status = online
    ? `<span class="chip on">● 在线</span>`
    : `<span class="chip off">✕ 离线</span>`
  const meta = online && h ? `块 #${h.lastBlock ?? '?'} · ${esc(h.rpc || '—')}${h.ok ? '' : ' · ⚠ RPC 异常'}` : h ? `${((now - h.lastTs) / 1000).toFixed(1)} 秒没有心跳` : '从未连上'
  let verdict = '<span class="dim">○ 待命</span>'
  let veto = ''
  const sp = p?.sentinels[s]
  if (p && sp) {
    if (sp.verdict === 'veto') {
      const r = sp.rule ?? '?'
      verdict = `<span class="bad">✕ 否决</span> <b>${esc(r.split('_')[0])}</b> ${esc(RULE_TEXT[r] ?? r)} <span class="dim">· 模拟 ${sp.simMs ?? '?'} ms</span>`
      if (sp.receipt) {
        veto = `<div class="barlabel">否决交易 ${txLink(sp.receipt.txHash)} · 块 #${sp.receipt.block ?? '?'} · 从看到提案 ${sp.receipt.latencyMs !== null ? (sp.receipt.latencyMs / 1000).toFixed(2) + ' 秒' : '?'} ${tag()}</div>${stageBar(sp.receipt.block, vetoStage(sp))}`
      } else if (sp.vetoTx) {
        veto = `<div class="barlabel">否决交易 ${txLink(sp.vetoTx)} 已送出 ${(sp.vetoRpcs ?? []).length} 路，等收据…</div>${stageBar(null)}`
      } else {
        veto = `<div class="barlabel">准备送出否决…</div>`
      }
    } else if (sp.verdict === 'pass') {
      verdict = `<span class="good">✓ 放行</span> 不变量全部守住 <span class="dim">· 模拟 ${sp.simMs ?? '?'} ms</span>`
      veto = `<div class="barlabel dim">放行不发任何交易</div>`
    } else if (sp.simStartedTs) {
      verdict = `<span class="warn">⏳ 模拟中…</span> 把新实现当攻击者打一遍`
    } else if (sp.seenTs) {
      verdict = `<span class="warn">👁 已看到提案 #${esc(p.id)}</span>（${esc(sp.path ?? '?')}）`
    }
  }
  patch(
    `s-${s}`,
    `<div class="scard-in ${online ? '' : 'offline'}">
      <div class="s-head"><b>哨兵 ${n}</b> ${status} <span class="dim">${meta}</span></div>
      <div class="s-verdict">${verdict}</div>
      <div class="s-veto">${veto}</div>
      ${online ? '' : '<div class="off-stamp">离线</div>'}
    </div>`,
  )
}

// ---------- 大字实测值 ----------
// 全部取自最先落地那张 veto_receipt（derive.vetoMetrics）；拿不到就显示等待，不用任何预设值。
function renderMetrics(p: Proposal | null) {
  if (!p) {
    patch('metrics', `<div class="m-empty">否决用了 <b>?</b> 块 ／ 攻击者还要等 <b>?</b> 块 <small>（全部显示实测值）</small></div>`)
    return
  }
  const v = verdictOf(p)
  if (v.verdict === 'pass') {
    const left = p.readyBlock ? Math.max(0, p.readyBlock - blocks.latest) : null
    patch(
      'metrics',
      `<div class="tile good"><div class="t-l">判定</div><div class="t-v">✓ 放行</div></div>
       <div class="tile"><div class="t-l">正常升级照常生效</div><div class="t-v">${left === null ? '?' : left > 0 ? `还剩 ${left} 块` : p.execute?.result === 'success' || p.chain?.status === 3 ? '已生效' : READ_ONLY ? '等 execute' : '执行中'} ${tag()}</div></div>
       <div class="tile"><div class="t-l">哨兵成本</div><div class="t-v">0 MON</div><div class="t-s">放行不发交易</div></div>`,
    )
    return
  }
  const m = vetoMetrics(p, SENTINELS)
  if (m) {
    let cost = '—'
    let costSub = READ_ONLY ? '正在读 eth_getTransactionReceipt…' : '收据缺 gasLimit 或 effectiveGasPrice'
    if (m.costWei !== null && m.gasLimit !== null && m.priceWei !== null) {
      cost = fmtMon(m.costWei)
      const mon = Number(m.costWei) / 1e18
      costSub = READ_ONLY
        ? `链上收据 gasUsed ${m.gasLimit.toLocaleString('en-US')} × ${fmtGwei(m.priceWei)}（Monad gasUsed＝gasLimit）`
        : `收据实测 gasLimit ${m.gasLimit.toLocaleString('en-US')} × ${fmtGwei(m.priceWei)}`
      if (CONFIG.monUsd.rate !== null) costSub += ` · ≈ $${(mon * CONFIG.monUsd.rate).toPrecision(3)}（汇率 ${esc(CONFIG.monUsd.date || '未注明日期')}，操作者手填）`
    }
    const who = m.who.split('-')[1] ?? m.who
    const lat = m.latencyMs !== null ? ` ${(m.latencyMs / 1000).toFixed(2)} 秒` : ''
    const chainVotes = READ_ONLY && p.chain ? `${Math.max(p.chain.vetoCount, m.vetoCount)}/3` : `${m.vetoCount}/3`
    patch(
      'metrics',
      `<div class="tile bad"><div class="t-l">否决用了 <small>提案块 → 否决收据块</small></div><div class="t-v"><b>${m.usedBlocks}</b> 块 ${tag()}</div><div class="t-s">哨兵 ${esc(who)} 最先落地${lat} · 块 #${m.block} · ${chainVotes} 已否决</div></div>
       <div class="tile"><div class="t-l">攻击者还要等 <small>否决块 → 可执行块</small></div><div class="t-v"><b>${m.waitBlocks}</b> 块 ${tag()}</div><div class="t-s">等到了也只会拿到 ProposalVetoed</div></div>
       <div class="tile"><div class="t-l">单次否决成本 <small>${READ_ONLY ? 'gasUsed' : 'gasLimit'} × effectiveGasPrice</small></div><div class="t-v">${esc(cost)} ${tag()}</div><div class="t-s">${costSub}</div></div>`,
    )
    return
  }
  const msg = READ_ONLY
    ? p.chain?.status === 2
      ? '✕ 链上已否决（Vetoed 不在提案后 100 块内，块数不计）'
      : '⏳ 冷静期中，链上还没有 Vetoed'
    : v.verdict === 'veto'
      ? '✕ 已判定否决，等否决交易上链…'
      : '⏳ 哨兵正在模拟新实现…'
  patch('metrics', `<div class="m-empty">${msg}</div>`)
}

// ---------- 事件串流 ----------
const SRC_CN: Record<string, string> = { 'sentinel-1': '哨兵1', 'sentinel-2': '哨兵2', 'sentinel-3': '哨兵3', driver: 'driver', reporter: '报告', chain: '链上' }
function renderStream(p: Proposal | null, docked: boolean) {
  // 串流区高 108px：标题＋4 行（style.css --stream-h）；.st-lines 贴底，最新一行永远看得到
  const lines = store.stream.slice(-4)
  // 报告浮层收起时，在串流标题右边留一个提示，按 R 可再打开
  const chip = READ_ONLY
    ? !docked && p && p.report.reportHash
      ? `<span class="st-chip">报告哈希 #${esc(p.id)} <span class="mono">${esc(short(p.report.reportHash, 4))}</span> · attachReason ${txLink(p.report.attachTx, 4)} · 按 R 展开</span>`
      : ''
    : !docked && p && p.report.text
      ? `<span class="st-chip">AI 报告 #${esc(p.id)} ${p.report.done ? '✓ 已收起' : '生成中'}${p.report.attachTx ? ` · attachReason ${txLink(p.report.attachTx, 4)}` : ''} · 按 R 展开</span>`
      : ''
  $('stream').classList.toggle('docked', docked)
  patch(
    'stream',
    `<div class="st-title">事件串流 <small>${READ_ONLY ? 'GuardedAdmin 链上 log：Proposed · Vetoed · Executed · ReasonAttached' : `3 个哨兵 · driver · reporter（SSE）${MODE === 'fake' ? ' · 假事件' : ''}`}</small>${chip}</div><div class="st-lines">` +
      lines
        .map((l) => {
          const d = new Date(l.ts)
          // Always show venue time (UTC+8), whatever the laptop's own time zone is.
          const t = `${d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai', hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`
          const ico = l.level === 'bad' ? '✕' : l.level === 'good' ? '✓' : l.level === 'warn' ? '!' : '·'
          return `<div class="ln ${l.level}"><span class="t">${t}</span><span class="src">${esc(SRC_CN[l.source] ?? l.source)}</span><span class="ico">${ico}</span>${esc(l.text)}</div>`
        })
        .join('') +
      '</div>',
  )
}

// ---------- S2 AI 报告浮层（右下角停靠，只盖事件串流的右半边，不挡哨兵卡与实测数字） ----------
export const ui = { reportOpen: false, judgeOpen: false, tableOpen: false, reportDismissedFor: '' }

/** 手动打开（R）就一直显示；否则串流中自动显示，完成后 CONFIG.reportAutoCloseMs 自动收起 */
export function reportVisible(now = Date.now()): boolean {
  return ui.reportOpen || reportAutoVisible(store.active, ui.reportDismissedFor, now, CONFIG.reportAutoCloseMs)
}

function renderReport(p: Proposal | null, show: boolean) {
  const el = $('ov-report')
  el.classList.toggle('hidden', !show)
  el.classList.toggle('manual', ui.reportOpen)
  if (!show) return
  if (READ_ONLY) {
    const r = p?.report
    patch(
      'ov-report',
      `<div class="r-head">AI 风险报告${p ? ` · #${esc(p.id)}` : ''}<span class="r-note">不在否决路径上，只给多签参考</span><button data-act="close-report" title="R 收起">✕</button></div>
       <div class="r-body"><div>${
         r?.reportHash
           ? `链上只存报告哈希（ReasonAttached 事件，由哨兵 1 代送）。<br>报告全文在操作者本机，本页不读取。`
           : '本提案链上没有 ReasonAttached（放行的提案不写报告，或报告还没送出）。'
       }</div></div>
       <div class="r-foot"><span>报告哈希 ${r?.reportHash ? `<span class="mono" title="${esc(r.reportHash)}">${esc(short(r.reportHash, 8))}</span>` : '—'}</span><span>attachReason ${r?.attachTx ? txLink(r.attachTx) : '—'}</span></div>`,
    )
    return
  }
  if (!p || !p.report.text) {
    patch('ov-report', `<div class="r-head">AI 风险报告<button data-act="close-report" title="R 收起">✕</button></div><div class="r-body dim"><div>本提案还没有报告。</div></div>`)
    return
  }
  const r = p.report
  const left = r.done && r.doneTs !== undefined && !ui.reportOpen ? Math.max(0, Math.ceil((CONFIG.reportAutoCloseMs - (Date.now() - r.doneTs)) / 1000)) : null
  const attach = r.attachTx
    ? `${txLink(r.attachTx)}${r.reportHash && r.hash && r.reportHash.toLowerCase() !== r.hash.toLowerCase() ? ' <span class="bad">⚠ 链上哈希不符</span>' : r.reportHash ? ' <span class="good">✓ 链上哈希一致</span>' : ''}`
    : '<span class="dim">等待哨兵 1 代送…</span>'
  patch(
    'ov-report',
    `<div class="r-head">AI 风险报告 · #${esc(p.id)} ${r.cached ? '<span class="tpl">模板</span>' : '<span class="ai">本机 Qwen</span>'}<span class="r-note">不在否决路径上，只给多签参考</span>${left !== null ? `<span class="r-left">${left} 秒后收起</span>` : ''}<button data-act="close-report" title="R 收起">✕</button></div>
     <div class="r-body"><div>${esc(r.text)}${r.done ? '' : '<span class="caret">▌</span>'}</div></div>
     <div class="r-foot"><span>报告哈希 ${r.hash ? `<span class="mono">${esc(short(r.hash, 6))}</span>` : '<span class="dim">生成中…</span>'}</span><span>attachReason ${attach}</span></div>`,
  )
}

// ---------- S3 评委出题 ----------
export const judge = {
  order: shuffle(CARDS.map((c) => c.id)),
  picked: null as CardId | null,
  pickedId: null as string | null,
  status: '',
}

function shuffle<T>(a: T[]): T[] {
  const r = new Uint32Array(a.length)
  crypto.getRandomValues(r)
  for (let i = a.length - 1; i > 0; i--) {
    const j = r[i] % (i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function renderJudge() {
  const el = $('ov-judge')
  el.classList.toggle('hidden', !ui.judgeOpen)
  if (!ui.judgeOpen) return
  const p = judge.pickedId ? store.proposals.get(judge.pickedId) : null
  const letters = ['A', 'B', 'C', 'D']
  const cards = judge.order
    .map((cid, i) => {
      const c = CARDS.find((x) => x.id === cid)!
      const isPicked = judge.picked === cid
      const open = isPicked && p && revealed(p)
      if (open) {
        const v = verdictOf(p!)
        return `<div class="jcard front flip ${c.expect}"><div class="j-l">${letters[i]}</div><div class="j-n">${esc(c.name)}</div><div class="j-d">${esc(c.desc)}</div><div class="j-r">${v.verdict === 'veto' ? `✕ 否决 ${esc(v.rule ?? '')}` : v.verdict === 'pass' ? '✓ 放行' : ''}</div></div>`
      }
      return `<div class="jcard back ${isPicked ? 'picked' : ''} ${judge.picked && !isPicked ? 'dim' : ''}" data-card="${cid}"><div class="j-l">${letters[i]}</div><div class="j-q">?</div><div class="j-d">${isPicked ? '已送出提案' : '点我出题'}</div></div>`
    })
    .join('')
  patch(
    'ov-judge',
    `<div class="ov-box">
      <div class="ov-title">评委出题 <small>四张牌里有 3 种攻击、1 个正常升级；洗过牌，我们也不知道哪张是哪张</small><button data-act="close-judge">✕</button></div>
      <div class="jrow">${cards}</div>
      <div class="ov-foot">${esc(judge.status)} <button data-act="reshuffle">重新洗牌</button></div>
    </div>`,
  )
}

// ---------- S5 30 区块对照表 ----------
function renderTable() {
  const el = $('ov-table')
  el.classList.toggle('hidden', !ui.tableOpen)
  if (!ui.tableOpen) return
  // 冷静期块数：优先用当前提案链上的 readyBlock − proposeBlock，其次部署资讯，最后才用设定档
  const ap = store.active
  const onchain = ap && ap.readyBlock && ap.proposeBlock ? ap.readyBlock - ap.proposeBlock : null
  const n = onchain ?? store.deploy?.delayBlocks ?? CONFIG.delayBlocks
  const raw = blocks.blockTimeMs()
  const bt = plausibleBlockMs(raw, CONFIG.minPlausibleBlockMs)
  const fmt = (sec: number) => (sec >= 60 ? `约 ${(sec / 60).toFixed(1)} 分钟` : `约 ${sec.toFixed(1)} 秒`)
  const rows = CONFIG.referenceChains
    .map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.note)}</td><td><b>${fmt(r.blockSec * n)}</b></td><td class="dim">参考值</td></tr>`)
    .join('')
  // Monad 一行永远用本页量到的秒/块（最近 blockTimeWindow 块的到达时间），不用任何参考值
  const samples = blocks.sampleBlocks()
  const monad = bt
    ? `<tr class="hl"><td>Monad${ON_TESTNET ? ' 测试网' : ''}</td><td>${(bt / 1000).toFixed(2)} 秒/块</td><td><b>${fmt((bt / 1000) * n)}</b></td><td>${ON_TESTNET ? '本页实测' : `${LOCAL_TAG}实测（不是测试网）`}<div class="t-n">最近 ${samples} 块</div></td></tr>`
    : `<tr class="hl"><td>Monad</td><td colspan="3">${raw !== null ? '本机快进挖块中，秒/块不计' : '测量中…'}</td></tr>`
  patch(
    'ov-table',
    `<div class="ov-box">
      <div class="ov-title">同样等 ${n} 个区块 <small>冷静期以区块计，不用 timestamp</small><button data-act="close-table">✕</button></div>
      <table class="cmp"><thead><tr><th>链</th><th>出块时间</th><th>${n} 块要等</th><th>来源</th></tr></thead><tbody>${rows}${monad}</tbody></table>
      <div class="ov-foot">冷静期短到团队没理由不装；哨兵在这段时间里先把新实现当攻击者打一遍。</div>
    </div>`,
  )
}

export function render() {
  const now = Date.now()
  const p = store.active
  renderTop()
  renderAttacker(p)
  if (attackerDirty()) autoFit('attacker')
  for (const s of SENTINELS) renderSentinel(s, p, now)
  renderMetrics(p)
  const docked = reportVisible(now)
  renderStream(p, docked)
  renderReport(p, docked)
  renderJudge()
  renderTable()
}
