// 战情室画面（1280×720 固定舞台，按视窗等比缩放）。
// 每个区块只在内容变化时才重写 innerHTML，翻牌动画只播一次。
// 画面文字一律走 i18n.t()（zh-CN／zh-TW／en）；换语言只是内容变了，照常由 patch() 重写。
import { blocks } from './chain'
import { CONFIG } from './config'
import { blockFontPx, explorerUrl, fmtGwei, fmtMon, plausibleBlockMs, reportAutoVisible, vetoMetrics } from './derive'
import { CARD_GUARDIAN, chainHealth, recentIds, replay, replayFrame } from './chainwatch'
import { replayStage, type ReplayFrame } from './replay'
import { cycleLang, lang, LANG_LABEL, LANGS, onLangChange, ruleText, srcName, stageName, statusChip, statusText, t, tLegacy, tm, tOr } from './i18n'
import { ARENA, CHAIN, HAS_COMMIT_STATE, LOCAL_TAG, MODE, ON_TESTNET, READ_ONLY, SENTINELS } from './runtime'
import { arena, waitLeft } from './arena'
import { ARENA_PENDING } from './chaindata'
import { short, store, type Proposal, type SentinelOnProposal } from './store'
import { CARDS, type CardId, type CardInfo } from './types'

const $ = (id: string) => document.getElementById(id)!

/** chain 模式自动回放中：攻击者／哨兵／大字指标用回放的虚拟区块；右上大区块号永远是真实最新区块 */
let RF: ReplayFrame | null = null
const curBlock = () => (RF ? RF.vblock : blocks.latest)
const stageOfBlock = (b: number) => (RF ? replayStage(b, RF.vblock) : blocks.stageOf(b))
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

/** 本机／假数据标注（runtime.LOCAL_TAG 的多语系版） */
const localTag = () => (!LOCAL_TAG ? '' : MODE === 'replay' ? t('tag.local') : t('tag.fake'))
const tag = () => (LOCAL_TAG ? `<span class="loc">${localTag()}</span>` : '')

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
  if (st === 'yes') return `<span class="vchip yes" title="Sourcify exact match">${t('chip.verified')}</span>`
  if (st === 'no' && showNo) return `<span class="vchip no" title="${esc(t('chip.noSourceTitle'))}">${t('chip.noSource')}</span>`
  return ''
}

/** 卡片说明按语言查（卡名是专有名词，不翻） */
const cardDesc = (c: CardInfo) => tOr(`card.${c.id}`, c.desc)

export function mountSkeleton() {
  $('app').innerHTML = `
  <div id="stage">
    <header id="top">
      <div class="top-left">
        <div class="badge-row"><span id="badge"></span><span id="ga" class="ga"></span></div>
        <div id="ttl" class="title"></div>
        <div id="link" class="link"></div>
      </div>
      <div id="toolbar" class="toolbar"></div>
      <div class="top-right">
        <div class="blk-meta"><span class="blk-label"><span id="blk-l"></span> <span id="blk-tag"></span></span><span id="bt" class="bt"></span></div>
        <div id="blk" class="blk">—</div>
      </div>
    </header>
    <main>
      <section id="attacker" class="panel">
        <div class="fit">
          <h2 id="h-att"></h2>
          <div id="pcard"></div>
          <div id="pbar"></div>
          <div id="countdown"></div>
          <div id="exec"></div>
        </div>
      </section>
      <section id="sentinels" class="panel">
        <h2 id="h-sen"></h2>
        ${SENTINELS.map((s) => `<div id="s-${s}" class="scard"></div>`).join('')}
      </section>
    </main>
    <section id="metrics"></section>
    <section id="stream"></section>
    <div id="ov-report" class="dock hidden"></div>
    <div id="ov-judge" class="overlay hidden"></div>
    <div id="ov-table" class="overlay hidden"></div>
  </div>`
  renderStatic()
  fitStage()
  window.addEventListener('resize', fitStage)
  // 工具列「简/繁/EN」：不走 main.ts 的 data-act，自己处理；换语言后 store.emit() 让主循环重画
  document.addEventListener('click', (ev) => {
    if ((ev.target as HTMLElement | null)?.closest?.('[data-lang]')) cycleLang()
  })
  onLangChange(() => store.emit())
}

function fitStage() {
  const s = Math.min(window.innerWidth / 1280, window.innerHeight / 720)
  const el = $('stage')
  el.style.transform = `scale(${s})`
  el.style.left = `${Math.max(0, (window.innerWidth - 1280 * s) / 2)}px`
  el.style.top = `${Math.max(0, (window.innerHeight - 720 * s) / 2)}px`
}

// ---------- 固定标题（只随语言改变） ----------
function renderStatic() {
  patch('ttl', `${t('title.main')} <span>${t('title.sub')}</span>`)
  patch('blk-l', t('blk.label'))
  patch(
    'h-att',
    RF
      ? `<span class="ico">☠</span> ${t('att.h')} <span class="rp-pill">${t('rp.pill', { id: esc(RF.tl.id), b: RF.tl.proposeBlock.toLocaleString('en-US') })}${RF.paused ? t('rp.paused') : ''}</span>`
      : `<span class="ico">☠</span> ${t('att.h')} <small>${t('att.sub')}</small>`,
  )
  patch('h-sen', `<span class="ico">⛨</span> ${t('sen.h')} <small>${t(MODE === 'arena' ? 'sen.sub.arena' : 'sen.sub')}</small>`)
}

/** 语言切换钮：当前语言实色，其他半透明（沿用工具列按钮样式，不加 CSS 规则） */
function langButton(): string {
  const cur = lang()
  const parts = LANGS.map((l) => (l === cur ? `<b>${LANG_LABEL[l]}</b>` : `<span style="opacity:.45">${LANG_LABEL[l]}</span>`)).join(' / ')
  return `<button data-lang="next" title="${esc(t('tb.langTitle'))}">${parts}</button>`
}

// ---------- 顶部 ----------
/** 云端只读版指向云端互动版（另一个 Pages 项目），带上目前语言 */
const ARENA_URL = 'https://eleven-seconds-arena.pages.dev/'
const arenaHref = () => `${ARENA_URL}?lang=${lang()}`

/** 右上角栏位宽度（与 style.css #top 第三栏一致）与区块数字最大字号 */
const BLK_WIDTH = 396
const BLK_MAX_PX = 84
function renderTop() {
  const badge =
    MODE === 'testnet' || MODE === 'chain' || MODE === 'arena'
      ? `<span class="badge live${READ_ONLY ? ' chain' : ''}${ARENA ? ' arena' : ''}">● ${esc(tOr(`badge.${MODE}`, CHAIN.badge))}</span>`
      : MODE === 'replay'
        ? `<span class="badge grey">${t('badge.replay')}</span>`
        : `<span class="badge grey dashed">${t('badge.fake')}</span>`
  patch('badge', badge)
  const linkText =
    blocks.link === 'ws'
      ? t('link.ws', { m: HAS_COMMIT_STATE ? 'monadNewHeads' : 'newHeads' })
      : blocks.link === 'poll'
        ? t('link.poll', { ms: CONFIG.pollMs })
        : blocks.link === 'fake'
          ? t('link.fake')
          : t('link.down')
  const logs = chainHealth.logsLink === 'ws' ? t('link.logsWs') : chainHealth.logsLink === 'poll' ? t('link.logsPoll', { c: chainHealth.cursor || '…' }) : t('link.connecting')
  patch('link', esc(READ_ONLY ? t('link.logs', { base: linkText, logs }) : linkText))
  // 守门合约地址（driver /deployments 提供；测试网可点、Sourcify 查验后加徽章）
  const ga = store.deploy?.guardedAdmin
  patch('ga', ga ? `<span class="ga-l" title="GuardedAdmin">${t('ga.label')} ${verifyChip(ga)}</span><span class="ga-a">${addrLink(ga, 6)} ${tag()}</span>` : '')
  const blkText = blocks.latest ? `#${blocks.latest.toLocaleString('en-US')}` : '—'
  if (prev.get('blk') !== blkText) $('blk').style.fontSize = `${blockFontPx(blkText, BLK_WIDTH, BLK_MAX_PX)}px`
  patch('blk', blkText)
  patch('blk-tag', `${tag()}${RF ? `<span class="rp-vb">${t('rp.vblock', { b: RF.vblock.toLocaleString('en-US') })}</span>` : ''}`)
  const raw = blocks.blockTimeMs()
  const bt = plausibleBlockMs(raw, CONFIG.minPlausibleBlockMs)
  patch('bt', bt ? t('bt.measured', { s: (bt / 1000).toFixed(2) }) : raw !== null ? t('bt.fast') : t('bt.measuring'))
  if (ARENA) {
    patch('toolbar', arenaToolbar())
    return
  }
  if (READ_ONLY) {
    const ids = recentIds()
    const chips = ids
      .map((id) => {
        const p = store.proposals.get(id)!
        const st = p.chain?.status
        const cls = st === 2 ? 'bad' : st === 3 ? 'good' : ''
        return `<button data-act="sel:${esc(id)}" class="${(RF ? RF.tl.id : store.activeId) === id ? 'on' : ''}"><b class="${cls}">#${esc(id)}</b> ${esc(st !== undefined ? statusChip(st) : '…')}</button>`
      })
      .join('')
    patch(
      'toolbar',
      `<span class="ro">${t('tb.readonly')}${MODE === 'chain' ? ` <a class="ro-arena" href="${esc(arenaHref())}" target="_blank" rel="noopener">${t('tb.arena')}</a>` : ''}</span><button data-act="table">${t('tb.table')}</button><button data-act="report">${t('tb.reportHash')}</button><button data-act="replay" class="rp-btn${replay.paused ? ' paused' : ''}" title="${esc(`${replay.paused ? t('rp.resumeFull') : t('rp.pauseFull')} · ${t('rp.btnTitle')}`)}" aria-label="${esc(replay.paused ? t('rp.resumeFull') : t('rp.pauseFull'))}">${replay.paused ? t('rp.resume') : t('rp.pause')}</button>${langButton()}` +
        (ids.length ? `<span class="hint">${t('tb.recent')}${chips}</span>` : `<span class="hint">${chainHealth.loadedRecent ? t('tb.noProposals') : t('tb.loadingRecent')}</span>`),
    )
    return
  }
  patch(
    'toolbar',
    `<button data-act="judge">${t('tb.judge')}</button><button data-act="table">${t('tb.table')}</button><button data-act="report">${t('tb.report')}</button>` +
      (MODE === 'fake' ? `<button data-act="kill">${t('tb.kill')}</button>` : `<button data-act="approve">${t('tb.approve')}</button>`) +
      `<span class="hint">${t('tb.propose')}<button data-act="p:evilMint">${t('tb.p1')}</button><button data-act="p:evilOwner">${t('tb.p2')}</button><button data-act="p:evilFee">${t('tb.p3')}</button><button data-act="p:v2">${t('tb.p4')}</button>${langButton()}</span>`,
  )
}

// ---------- ?mode=arena 工具列：说明一句＋四张攻击卡＋送出状态＋T/R/P/语言＋最近提案 ----------
function arenaStatus(now: number): string {
  if (ARENA_PENDING) return `<span class="ar-st warn">${t('ar.pending')}</span>`
  const st = arena.status
  const left = waitLeft(now)
  const name = (c: CardId) => esc(t(`ar.card.${c}` as never).replace(/^[☠✓]\s*/, ''))
  let main = ''
  let cls = ''
  if (st?.kind === 'sending') main = t('ar.sending')
  else if (st?.kind === 'sent') {
    main = st.id ? t('ar.sent', { id: esc(st.id), card: name(st.card) }) : t('ar.sentNoId', { card: name(st.card) })
    cls = 'good'
  } else if (st?.kind === 'error') {
    main = t('ar.error', { err: esc(st.err) })
    cls = 'bad'
  } else if (st?.kind === 'timeout') {
    main = t('ar.timeout', { card: name(st.card) })
    cls = 'warn'
  }
  // 倒数：刚送出的接在「已送出」后面；其他情况（429、云端忙）单独一句
  if (left > 0) {
    const wait = st?.kind === 'sent' ? t('ar.again', { s: left }) : t(arena.busy && st?.kind !== 'limited' ? 'ar.busy' : 'ar.limited', { s: left })
    main = main ? `${main} · ${wait}` : wait
    if (!cls) cls = 'warn'
  } else if (st?.kind === 'limited') {
    main = t('ar.ready')
    cls = 'good'
  }
  if (!main) return arena.stateErr && arena.primed ? `<span class="ar-st dim">${t('ar.stateDown')}</span>` : ''
  return `<span class="ar-st ${cls}" role="status">${main}</span>`
}

function arenaToolbar(): string {
  const now = Date.now()
  const off = ARENA_PENDING || !!arena.sending || waitLeft(now) > 0
  const cards = CARDS.map((c, i) => {
    const label = t(`ar.card.${c.id}` as never)
    const title = t('ar.cardTitle', { name: c.name, desc: cardDesc(c), k: i + 1 })
    return `<button data-act="atk:${c.id}" class="atk ${c.expect}${arena.sending === c.id ? ' busy' : ''}"${off ? ' disabled' : ''} title="${esc(title)}">${esc(label)}</button>`
  }).join('')
  // 宽屏舞台上放得下几个就显示几个（.ar-hint 只留一行高，折到第二行的整颗隐藏）；手机版全显示
  const ids = recentIds()
  const chips = ids
    .map((id) => {
      const p = store.proposals.get(id)!
      const st = p.chain?.status
      const cls = st === 2 ? 'bad' : st === 3 ? 'good' : ''
      return `<button data-act="sel:${esc(id)}" class="${(RF ? RF.tl.id : store.activeId) === id ? 'on' : ''}"><b class="${cls}">#${esc(id)}</b> ${esc(st !== undefined ? statusChip(st) : '…')}</button>`
    })
    .join('')
  return (
    `<span class="ro ar-lede">${t('ar.lede')}</span>` +
    `<div class="atk-row" role="group" aria-label="${esc(t('ar.lede'))}">${cards}</div>` +
    arenaStatus(now) +
    `<span class="hint ar-hint"><button data-act="table">${t('tb.table')}</button><button data-act="report">${t('r.title')}</button><button data-act="replay" class="rp-btn${replay.paused ? ' paused' : ''}" title="${esc(`${replay.paused ? t('rp.resumeFull') : t('rp.pauseFull')} · ${t('rp.btnTitle')}`)}" aria-label="${esc(replay.paused ? t('rp.resumeFull') : t('rp.pauseFull'))}">${replay.paused ? t('rp.resume') : t('rp.pause')}</button>${langButton()}${chips}</span>`
  )
}

// ---------- 四段状态条 ----------
function stageBar(block: number | null | undefined, floor = -1): string {
  if (!block) return `<div class="bar"><span class="seg off">${t('bar.waitChain')}</span></div>`
  if (!HAS_COMMIT_STATE) {
    const ok = curBlock() >= block
    return `<div class="bar grey"><span class="seg ${ok ? 'on' : 'off'}">${ok ? t('bar.mined') : t('bar.waitBlock')} #${block}</span><span class="seg note">${t('bar.noStages')}</span></div>`
  }
  const st = Math.max(stageOfBlock(block), floor)
  return `<div class="bar">${[0, 1, 2, 3]
    .map((i) => {
      const cls = i <= st ? 'on' : i === st + 1 ? 'next' : 'off'
      const ico = i <= st ? '✓' : '○'
      return `<span class="seg ${cls} st${i}">${ico} ${stageName(i)}</span>`
    })
    .join('')}</div>`
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
  if (!revealed(p)) return `<div class="mini back"><div>?</div><small>${t('mini.hidden')}</small></div>`
  if (!c) return `<div class="mini front unknown"><div>${t('mini.unknown')}</div><small>${t('mini.bytecode')}</small></div>`
  const v = verdictOf(p)
  const match = v.verdict === null ? '' : v.verdict === c.expect ? `<b class="good">${t('mini.match')}</b>` : `<b class="bad">${t('mini.mismatch')}</b>`
  return `<div class="mini front ${p.judge ? 'flip' : ''} ${c.expect}"><div>${esc(c.name)}</div><small>${esc(cardDesc(c))}</small>${match}</div>`
}

function renderAttacker(p: Proposal | null) {
  if (!p) {
    patch(
      'pcard',
      ARENA
        ? `<div class="empty">${chainHealth.loadedRecent || ARENA_PENDING ? t('ar.emptyLoaded') : t('att.emptyChainLoading')}<br><small>${t('ar.emptySub')}</small></div>`
        : READ_ONLY
        ? `<div class="empty">${chainHealth.loadedRecent ? t('att.emptyChainLoaded') : t('att.emptyChainLoading')}<br><small>${t('att.emptyChainSub')}</small></div>`
        : `<div class="empty">${t('att.empty')}<br><small>${t('att.emptySub')}</small></div>`,
    )
    patch('pbar', '')
    patch('countdown', '')
    patch('exec', '')
    return
  }
  const kind = tOr(`kind.${p.kind}`, t('pc.kindN', { n: p.kind }))
  const c = cardOf(p)
  const showName = revealed(p) && c
  patch(
    'pcard',
    `<div class="pc">
      <div class="pc-main">
        <div class="pc-title">${t('pc.title', { id: esc(p.id), kind: esc(kind) })}${p.dropped ? ` <span class="bad">${t('pc.dropped')}</span>` : ''}${p.chain ? ` <span class="chainst s${p.chain.status}">${t('pc.chainSt', { st: esc(statusText(p.chain.status) || p.chain.statusName) })}</span>` : ''}</div>
        <div class="pc-row">${t('pc.newImpl')} ${addrLink(p.target, 8)}${showName ? ` <b>${esc(c!.name)}</b>` : ''}${revealed(p) ? ` ${verifyChip(p.target, true)}` : ''}</div>
        <div class="pc-row">codehash <span class="mono">${esc(short(p.codehash, 8))}</span></div>
        <div class="pc-row">${t('pc.blocks', { a: p.proposeBlock ?? '?', b: p.readyBlock ?? '?' })} ${tag()}</div>
      </div>
      <div class="pc-mini" id="mini-${esc(p.id)}">${miniCard(p)}</div>
    </div>`,
  )
  patch('pbar', `<div class="barlabel">${t('pc.proposeTx')} ${txLink(p.proposeTx)}</div>${stageBar(p.proposeBlock)}`)

  const v = verdictOf(p)
  let cd = ''
  if (p.readyBlock && p.proposeBlock) {
    const total = Math.max(1, p.readyBlock - p.proposeBlock)
    const left = Math.min(total, Math.max(0, p.readyBlock - curBlock()))
    const pct = Math.min(100, Math.round(((total - left) / total) * 100))
    const head = left > 0 ? t('cd.left', { n: left }) : t('cd.over', { n: total })
    const sub =
      v.verdict === 'veto' || p.chain?.status === 2
        ? `<span class="bad">${t('cd.vetoed')}</span>`
        : v.verdict === 'pass'
          ? READ_ONLY
            ? `<span class="good">${t('cd.noVetoChain')}</span>`
            : `<span class="good">${t('cd.passed')}</span>`
          : READ_ONLY
            ? `<span>${t('cd.waitChain')}</span>`
            : `<span>${t('cd.deciding')}</span>`
    cd = `<div class="cd"><div class="cd-head">${head} ${tag()}</div><div class="prog"><i style="width:${pct}%"></i></div><div class="cd-sub">${sub}</div></div>`
  }
  patch('countdown', cd)

  let ex = ''
  if (READ_ONLY && !p.execute) {
    const st = p.chain?.status
    ex =
      RF && st === 2 && p.readyBlock && curBlock() >= p.readyBlock
        ? `<div class="exec bad"><span>✕ ${t('rp.ready')}</span><span class="sub">getProposal(${esc(p.id)}).vetoCount = ${p.chain!.vetoCount}</span></div>`
        : st === 2
        ? `<div class="exec bad"><span>${t('ex.chainVetoed')}</span><span class="sub">getProposal(${esc(p.id)}).vetoCount = ${p.chain!.vetoCount}</span></div>`
        : st === 3
          ? `<div class="exec good"><span>${t('ex.chainExecuted')}</span><span class="sub">${t('ex.chainExecutedSub')}</span></div>`
          : p.readyBlock && curBlock() >= p.readyBlock
            ? `<div class="exec wait">${t('ex.chainReady', { b: p.readyBlock })}</div>`
            : `<div class="exec wait">${t('ex.notYet', { b: p.readyBlock ?? '?' })}</div>`
    patch('exec', ex)
    return
  }
  if (p.execute) {
    if (p.execute.result === 'success') {
      const ver = p.execute.extra?.version
      const what = c?.id === 'v2' || ver === '2' ? 'v2' : t('ex.newImpl')
      ex = `<div class="exec good"><span>${t('ex.ok', { what, ver: ver !== undefined && ver !== null ? ` · version() = "${esc(ver)}"` : '' })}</span><span class="sub">tx ${txLink(p.execute.txHash)}</span></div>`
    } else {
      ex = `<div class="exec bad"><span>${t('ex.revert', { err: esc(p.execute.error ?? t('ex.unknownErr')) })}</span><span class="sub">${t('ex.revertTx', { tx: txLink(p.execute.txHash) })}</span></div>`
    }
  } else if (p.readyBlock && curBlock() >= p.readyBlock) {
    ex = `<div class="exec wait">${t('ex.running')}</div>`
  } else {
    ex = `<div class="exec wait">${t('ex.notYet', { b: p.readyBlock ?? '?' })}</div>`
  }
  patch('exec', ex)
}

let attackerKey = ''
/** 攻击者面板任一块有变才重新量高度（避免每帧强制排版；标题随语言变也算） */
function attackerDirty(): boolean {
  const k = ['h-att', 'pcard', 'pbar', 'countdown', 'exec'].map((id) => prev.get(id) ?? '').join('\u0000')
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
  let verdict = `<span class="dim">${t('s.noAction')}</span>`
  let veto = ''
  const sp = p?.sentinels[s]
  // arena：云端哨兵回报的模拟毫秒（/api/state）
  const sim = ARENA && sp?.simMs !== undefined ? ` <span class="dim">${t('s.simMs', { ms: sp.simMs })}</span>` : ''
  if (p && sp) {
    if (sp.verdict === 'veto') {
      const r = sp.rule ?? '?'
      const rc = sp.receipt
      const used = rc?.block && p.proposeBlock ? rc.block - p.proposeBlock : null
      verdict = `<span class="bad">${t('s.veto')}</span> <b>${esc(r.split('_')[0])}</b> ${esc(ruleText(r))}${sim}`
      veto = `<div class="barlabel">${t('s.vetoedLine', { tx: txLink(sp.vetoTx), b: rc?.block ?? '?', used: used !== null ? t('s.usedAfter', { n: used }) : '' })}</div>${stageBar(rc?.block ?? null)}`
    } else if (sp.verdict === 'pass') {
      verdict = sim ? `<span class="good">${t('s.pass')}</span> ${t('s.passSub')}${sim}` : `<span class="good">${t('s.noVeto')}</span> ${t('s.noVetoSub')}`
      veto = `<div class="barlabel dim">${t('s.passNoTx')}</div>`
    } else if (p.chain?.status === 2) {
      verdict = `<span class="dim">${t('s.otherVetoed')}</span>`
    } else if (p.chain?.status === 1) {
      verdict = `<span class="warn">${t('s.cooling')}</span> ${t('s.coolingSub')}`
    }
  }
  patch(
    `s-${s}`,
    `<div class="scard-in">
      <div class="s-head"><b>${t('s.name', { n })}</b> ${ARENA ? (arena.health[s]?.online === false ? `<span class="chip off">${t('s.offline')}</span>` : `<span class="chip on">${t('ar.cloud')}</span>`) + ' ' : ''}<span class="chip on">guardian</span> <span class="dim">${addrLink(g, 4)}</span></div>
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
  const status = online ? `<span class="chip on">${t('s.online')}</span>` : `<span class="chip off">${t('s.offline')}</span>`
  const meta =
    online && h
      ? `${t('s.meta', { b: h.lastBlock ?? '?', rpc: esc(h.rpc || '—') })}${h.ok ? '' : t('s.rpcBad')}`
      : h
        ? t('s.noHeartbeat', { s: ((now - h.lastTs) / 1000).toFixed(1) })
        : t('s.never')
  let verdict = `<span class="dim">${t('s.standby')}</span>`
  let veto = ''
  const sp = p?.sentinels[s]
  if (p && sp) {
    if (sp.verdict === 'veto') {
      const r = sp.rule ?? '?'
      verdict = `<span class="bad">${t('s.veto')}</span> <b>${esc(r.split('_')[0])}</b> ${esc(ruleText(r))} <span class="dim">${t('s.simMs', { ms: sp.simMs ?? '?' })}</span>`
      if (sp.receipt) {
        const lat = sp.receipt.latencyMs !== null ? t('s.sec', { s: (sp.receipt.latencyMs / 1000).toFixed(2) }) : '?'
        veto = `<div class="barlabel">${t('s.vetoTx', { tx: txLink(sp.receipt.txHash), b: sp.receipt.block ?? '?', lat })} ${tag()}</div>${stageBar(sp.receipt.block, vetoStage(sp))}`
      } else if (sp.vetoTx) {
        veto = `<div class="barlabel">${t('s.vetoSent', { tx: txLink(sp.vetoTx), n: (sp.vetoRpcs ?? []).length })}</div>${stageBar(null)}`
      } else {
        veto = `<div class="barlabel">${t('s.vetoPrep')}</div>`
      }
    } else if (sp.verdict === 'pass') {
      verdict = `<span class="good">${t('s.pass')}</span> ${t('s.passSub')} <span class="dim">${t('s.simMs', { ms: sp.simMs ?? '?' })}</span>`
      veto = `<div class="barlabel dim">${t('s.passNoTx')}</div>`
    } else if (sp.simStartedTs) {
      verdict = `<span class="warn">${t('s.simulating')}</span> ${t('s.simulatingSub')}`
    } else if (sp.seenTs) {
      verdict = `<span class="warn">${t('s.seen', { id: esc(p.id) })}</span>${t('s.seenPath', { path: esc(sp.path ?? '?') })}`
    }
  }
  patch(
    `s-${s}`,
    `<div class="scard-in ${online ? '' : 'offline'}">
      <div class="s-head"><b>${t('s.name', { n })}</b> ${status} <span class="dim">${meta}</span></div>
      <div class="s-verdict">${verdict}</div>
      <div class="s-veto">${veto}</div>
      ${online ? '' : `<div class="off-stamp">${t('s.offStamp')}</div>`}
    </div>`,
  )
}

// ---------- 大字实测值 ----------
// 全部取自最先落地那张 veto_receipt（derive.vetoMetrics）；拿不到就显示等待，不用任何预设值。
function renderMetrics(p: Proposal | null) {
  if (!p) {
    patch('metrics', `<div class="m-empty">${t('m.empty')}</div>`)
    return
  }
  const v = verdictOf(p)
  if (v.verdict === 'pass') {
    const left = p.readyBlock ? Math.max(0, p.readyBlock - curBlock()) : null
    const state =
      left === null
        ? '?'
        : left > 0
          ? t('m.left', { n: left })
          : p.execute?.result === 'success' || p.chain?.status === 3
            ? t('m.live')
            : READ_ONLY
              ? t('m.waitExec')
              : t('m.executing')
    patch(
      'metrics',
      `<div class="tile good"><div class="t-l">${t('m.verdict')}</div><div class="t-v">${t('m.pass')}</div></div>
       <div class="tile"><div class="t-l">${t('m.normalLive')}</div><div class="t-v">${state} ${tag()}</div></div>
       <div class="tile"><div class="t-l">${t('m.cost')}</div><div class="t-v">0 MON</div><div class="t-s">${t('m.passNoTx')}</div></div>`,
    )
    return
  }
  const m = vetoMetrics(p, SENTINELS)
  if (m) {
    let cost = '—'
    let costSub = READ_ONLY ? t('m.readingReceipt') : t('m.receiptMissing')
    if (m.costWei !== null && m.gasLimit !== null && m.priceWei !== null) {
      cost = fmtMon(m.costWei)
      const mon = Number(m.costWei) / 1e18
      const g = m.gasLimit.toLocaleString('en-US')
      costSub = READ_ONLY ? t('m.chainReceipt', { g, p: fmtGwei(m.priceWei) }) : t('m.receipt', { g, p: fmtGwei(m.priceWei) })
      if (CONFIG.monUsd.rate !== null) costSub += t('m.usd', { usd: (mon * CONFIG.monUsd.rate).toPrecision(3), date: esc(CONFIG.monUsd.date || t('m.undated')) })
    }
    const who = m.who.split('-')[1] ?? m.who
    const lat = m.latencyMs !== null ? t('m.lat', { s: (m.latencyMs / 1000).toFixed(2) }) : ''
    const chainVotes = READ_ONLY && p.chain ? `${Math.max(p.chain.vetoCount, m.vetoCount)}/3` : `${m.vetoCount}/3`
    patch(
      'metrics',
      `<div class="tile bad"><div class="t-l">${t('m.vetoTook')}</div><div class="t-v">${t('m.blocks', { n: m.usedBlocks })} ${tag()}</div><div class="t-s">${t('m.firstLanded', { who: esc(who), lat, b: m.block, votes: chainVotes })}</div></div>
       <div class="tile"><div class="t-l">${t('m.attackerWaits')}</div><div class="t-v">${t('m.blocks', { n: m.waitBlocks })} ${tag()}</div><div class="t-s">${t('m.onlyVetoed')}</div></div>
       <div class="tile"><div class="t-l">${t('m.costPer', { f: READ_ONLY ? 'gasUsed' : 'gasLimit' })}</div><div class="t-v">${esc(cost)} ${tag()}</div><div class="t-s">${costSub}</div></div>`,
    )
    return
  }
  const msg = READ_ONLY ? (p.chain?.status === 2 ? t('m.chainVetoedFar') : t('m.chainCooling')) : v.verdict === 'veto' ? t('m.vetoPending') : t('m.simulating')
  patch('metrics', `<div class="m-empty">${msg}</div>`)
}

// ---------- 事件串流 ----------
function renderStream(p: Proposal | null, docked: boolean) {
  // 串流区高 108px：标题＋4 行（style.css --stream-h）；.st-lines 贴底，最新一行永远看得到
  const lines = store.stream.slice(-4)
  // 报告浮层收起时，在串流标题右边留一个提示，按 R 可再打开
  const chip = READ_ONLY
    ? !docked && p && p.report.reportHash
      ? `<span class="st-chip">${t('st.chipHash', { id: esc(p.id), hash: `<span class="mono">${esc(short(p.report.reportHash, 4))}</span>`, tx: txLink(p.report.attachTx, 4) })}</span>`
      : ''
    : !docked && p && p.report.text
      ? `<span class="st-chip">${t('st.chipReport', { id: esc(p.id), st: p.report.done ? t('st.hidden') : t('st.generating'), attach: p.report.attachTx ? ` · attachReason ${txLink(p.report.attachTx, 4)}` : '' })}</span>`
      : ''
  $('stream').classList.toggle('docked', docked)
  patch(
    'stream',
    `<div class="st-title">${t('st.title')} <small>${READ_ONLY ? t('st.subChain') : t('st.sub', { fake: MODE === 'fake' ? t('st.fake') : '' })}</small>${chip}</div><div class="st-lines">` +
      lines
        .map((l) => {
          const d = new Date(l.ts)
          // Always show venue time (UTC+8), whatever the laptop's own time zone is.
          const ts = `${d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai', hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`
          const ico = l.level === 'bad' ? '✕' : l.level === 'good' ? '✓' : l.level === 'warn' ? '!' : '·'
          const text = l.msg ? tm(l.msg) : tLegacy(l.text)
          const rp = l.replay ? `<span class="rp-tag">${t('rp.prefix')}</span>` : ''
          return `<div class="ln ${l.level}${l.replay ? ' rp' : ''}"><span class="t">${ts}</span><span class="src">${esc(srcName(l.source))}</span><span class="ico">${ico}</span>${rp}${esc(text)}</div>`
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

/** 报告正文不翻译（reporter 原文）；画面语言与正文语言不同时，标出正文是哪种语言 */
function reportLangChip(text: string): string {
  if (text.length < 24) return '' // 串流刚开始字太少，先不判断
  const zh = /[一-鿿]/.test(text)
  const cur = lang()
  if (zh && cur === 'en') return ` <span class="tpl">${t('r.origZh')}</span>`
  if (!zh && cur !== 'en' && /[A-Za-z]{3}/.test(text)) return ` <span class="tpl">${t('r.origEn')}</span>`
  return ''
}

function renderReport(p: Proposal | null, show: boolean) {
  const el = $('ov-report')
  el.classList.toggle('hidden', !show)
  el.classList.toggle('manual', ui.reportOpen)
  if (!show) return
  const close = `<button data-act="close-report" title="${esc(t('r.closeTitle'))}">✕</button>`
  // arena：/api/state 给了报告全文就照 S2 版面显示全文（否则同 chain 只显示链上哈希）
  if (READ_ONLY && !(ARENA && p?.report.text)) {
    const r = p?.report
    patch(
      'ov-report',
      `<div class="r-head">${t('r.title')}${p ? ` · #${esc(p.id)}` : ''}<span class="r-note">${t('r.note')}</span>${close}</div>
       <div class="r-body"><div>${r?.reportHash ? t('r.chainHas') : t('r.chainNone')}</div></div>
       <div class="r-foot"><span>${t('r.hash')} ${r?.reportHash ? `<span class="mono" title="${esc(r.reportHash)}">${esc(short(r.reportHash, 8))}</span>` : '—'}</span><span>attachReason ${r?.attachTx ? txLink(r.attachTx) : '—'}</span></div>`,
    )
    return
  }
  if (!p || !p.report.text) {
    patch('ov-report', `<div class="r-head">${t('r.title')}${close}</div><div class="r-body dim"><div>${t('r.none')}</div></div>`)
    return
  }
  const r = p.report
  const left = r.done && r.doneTs !== undefined && !ui.reportOpen ? Math.max(0, Math.ceil((CONFIG.reportAutoCloseMs - (Date.now() - r.doneTs)) / 1000)) : null
  const attach = r.attachTx
    ? `${txLink(r.attachTx)}${r.reportHash && r.hash && r.reportHash.toLowerCase() !== r.hash.toLowerCase() ? ` <span class="bad">${t('r.hashBad')}</span>` : r.reportHash ? ` <span class="good">${t('r.hashOk')}</span>` : ''}`
    : `<span class="dim">${t('r.waitRelay')}</span>`
  patch(
    'ov-report',
    `<div class="r-head">${t('r.title')} · #${esc(p.id)} ${r.cached ? `<span class="tpl">${t('r.tpl')}</span>` : `<span class="ai">${t('r.ai')}</span>`}${reportLangChip(r.text)}<span class="r-note">${t('r.note')}</span>${left !== null ? `<span class="r-left">${t('r.left', { n: left })}</span>` : ''}${close}</div>
     <div class="r-body"><div>${esc(r.text)}${r.done ? '' : '<span class="caret">▌</span>'}</div></div>
     <div class="r-foot"><span>${t('r.hash')} ${r.hash ? `<span class="mono">${esc(short(r.hash, 6))}</span>` : `<span class="dim">${t('r.generating')}</span>`}</span><span>attachReason ${attach}</span></div>`,
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
        return `<div class="jcard front flip ${c.expect}"><div class="j-l">${letters[i]}</div><div class="j-n">${esc(c.name)}</div><div class="j-d">${esc(cardDesc(c))}</div><div class="j-r">${v.verdict === 'veto' ? t('j.veto', { rule: esc(v.rule ?? '') }) : v.verdict === 'pass' ? t('j.pass') : ''}</div></div>`
      }
      return `<div class="jcard back ${isPicked ? 'picked' : ''} ${judge.picked && !isPicked ? 'dim' : ''}" data-card="${cid}"><div class="j-l">${letters[i]}</div><div class="j-q">?</div><div class="j-d">${isPicked ? t('j.sent') : t('j.pick')}</div></div>`
    })
    .join('')
  patch(
    'ov-judge',
    `<div class="ov-box">
      <div class="ov-title">${t('j.title')} <small>${t('j.sub')}</small><button data-act="close-judge">✕</button></div>
      <div class="jrow">${cards}</div>
      <div class="ov-foot">${esc(tLegacy(judge.status))} <button data-act="reshuffle">${t('j.reshuffle')}</button></div>
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
  const fmt = (sec: number) => (sec >= 60 ? t('tbl.min', { m: (sec / 60).toFixed(1) }) : t('tbl.sec', { s: sec.toFixed(1) }))
  const rows = CONFIG.referenceChains
    .map((r) => {
      const name = tOr(`ref.${r.id}`, r.name)
      const note = lang() === 'zh-CN' ? r.note : t('tbl.refNote', { s: r.blockSec })
      return `<tr><td>${esc(name)}</td><td>${esc(note)}</td><td><b>${fmt(r.blockSec * n)}</b></td><td class="dim">${t('tbl.ref')}</td></tr>`
    })
    .join('')
  // Monad 一行永远用本页量到的秒/块（最近 blockTimeWindow 块的到达时间），不用任何参考值
  const samples = blocks.sampleBlocks()
  const monad = bt
    ? `<tr class="hl"><td>${ON_TESTNET ? t('tbl.monadTestnet') : 'Monad'}</td><td>${t('tbl.sPerBlock', { s: (bt / 1000).toFixed(2) })}</td><td><b>${fmt((bt / 1000) * n)}</b></td><td>${ON_TESTNET ? t('tbl.measuredHere') : t('tbl.measuredLocal', { tag: localTag() })}<div class="t-n">${t('tbl.lastN', { n: samples })}</div></td></tr>`
    : `<tr class="hl"><td>Monad</td><td colspan="3">${raw !== null ? t('tbl.fast') : t('tbl.measuring')}</td></tr>`
  patch(
    'ov-table',
    `<div class="ov-box">
      <div class="ov-title">${t('tbl.title', { n })}<button data-act="close-table">✕</button></div>
      <table class="cmp"><thead><tr><th>${t('tbl.chain')}</th><th>${t('tbl.bt')}</th><th>${t('tbl.wait', { n })}</th><th>${t('tbl.src')}</th></tr></thead><tbody>${rows}${monad}</tbody></table>
      <div class="ov-foot">${t('tbl.foot')}</div>
    </div>`,
  )
}

export function render() {
  const now = Date.now()
  RF = READ_ONLY ? replayFrame(now) : null
  const p = RF ? RF.p : store.active
  renderStatic()
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
