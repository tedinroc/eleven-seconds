// Turn a sim_result (+ the matching proposal_seen) into pre-computed facts.
// Every number that can appear in a report is computed here, never by the model.
import { RULE_LABELS, KIND_LABELS, normalizeKind, normalizeRuleId } from './rules.mjs';

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_RE = /^0x[0-9a-fA-F]+$/;

export function shortHex(s, head = 6, tail = 4) {
  if (typeof s !== 'string' || !HEX_RE.test(s)) return s == null ? '' : String(s);
  if (s.length <= 2 + head + tail + 1) return s;
  return `${s.slice(0, 2 + head - 2)}…${s.slice(-tail)}`;
}

function toBigIntOrNull(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
  return null;
}

function groupThousands(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function sci(abs) {
  // abs: positive bigint string of digits -> "1.16×10^59"
  const d = abs.replace(/^0+/, '') || '0';
  const exp = d.length - 1;
  const mant = `${d[0]}${d.length > 1 ? '.' + d.slice(1, 3) : ''}`.replace(/\.?0+$/, '');
  return `${mant}×10^${exp}`;
}

/** Format an integer amount (raw units). decimals=null -> raw integer. */
export function formatAmount(x, decimals) {
  const neg = x < 0n;
  let abs = neg ? -x : x;
  let intPart;
  let frac = '';
  if (Number.isInteger(decimals) && decimals > 0) {
    const base = 10n ** BigInt(decimals);
    intPart = (abs / base).toString();
    const f = (abs % base).toString().padStart(decimals, '0').slice(0, 4).replace(/0+$/, '');
    frac = f ? `.${f}` : '';
    if (intPart === '0' && !frac && abs > 0n) {
      // smaller than 0.0001 unit: show raw to avoid printing "0"
      return `${neg ? '-' : ''}${groupThousands(abs.toString())} 最小单位`;
    }
  } else {
    intPart = abs.toString();
  }
  const body = intPart.length > 15 ? `约 ${sci(intPart)}` : `${groupThousands(intPart)}${frac}`;
  return `${neg ? '-' : ''}${body}`;
}

function pctText(before, delta) {
  if (before === 0n) return delta === 0n ? '0%' : '从 0 起';
  // percent with 2 decimals, computed in bigint
  const bp = (delta * 1000000n) / before; // percent * 10^4
  const absBp = bp < 0n ? -bp : bp;
  if (absBp >= 10000000n) {
    // >= 1000%: express as a multiple of the original
    const after = before + delta;
    const mult = after / before;
    const m = mult.toString();
    return `约为原来的 ${m.length > 15 ? sci(m) : groupThousands(m)} 倍`;
  }
  const sign = bp < 0n ? '-' : '+';
  const whole = absBp / 10000n;
  const dec = (absBp % 10000n).toString().padStart(4, '0').slice(0, 2);
  return `${sign}${whole}.${dec}%`;
}

function valueText(v, decimals, unit) {
  const b = toBigIntOrNull(v);
  if (b !== null) return { text: `${formatAmount(b, decimals)}${unit ? ' ' + unit : ''}`, num: b };
  if (typeof v === 'string' && ADDR_RE.test(v)) return { text: shortHex(v), num: null };
  if (typeof v === 'string' && HEX_RE.test(v) && v.length > 20) return { text: shortHex(v, 8, 4), num: null };
  if (typeof v === 'boolean') return { text: v ? '成功' : '失败', num: null };
  if (v === null || v === undefined) return { text: '（无）', num: null };
  if (typeof v === 'object') return { text: JSON.stringify(v).slice(0, 60), num: null };
  return { text: String(v).slice(0, 80), num: null };
}

const AMOUNT_NAME_RE = /supply|balance|amount|余额|供应|transfer_conservation|holder|recipient|receiver|watch/i;

// Sentinel check names are rule IDs; give them readable names for the report.
const CHECK_NAMES = [
  [/^R1_/, 'totalSupply'],
  [/^R2_/, 'owner'],
  [/^R3_/, '收款地址到账'],
  [/^R3B_/, '第三方余额'],
  [/^R4_/, '持有人正常转账'],
  [/^R9_/, '危险操作码'],
];

// R9: opcode names the sentinel reports (sentinel/src/bytecode.mjs DANGEROUS_OPCODES).
const OPCODE_RE = /\b(ORIGIN|BLOCKHASH|COINBASE|TIMESTAMP|NUMBER|PREVRANDAO|GAS|CREATE2|CREATE|CALLCODE|DELEGATECALL|STATICCALL|CALL|SELFDESTRUCT)\b/g;
function opcodeList(v) {
  const s = Array.isArray(v) ? v.map(String).join(' ') : typeof v === 'string' ? v : '';
  return [...new Set(s.toUpperCase().match(OPCODE_RE) ?? [])];
}
/** Opcodes present in `after` but not in `before` (either may be an array or a string). */
export function addedOpcodes(before, after) {
  const old = new Set(opcodeList(before));
  return opcodeList(after).filter((o) => !old.has(o)).sort();
}
function displayName(raw) {
  for (const [re, label] of CHECK_NAMES) if (re.test(raw)) return label;
  return raw;
}

const RECV_RE = /^receiver\+(-?\d+)$/; // sentinel R3 format: "receiver+<amount>"

/** One check -> structured, human-readable facts. */
export function describeCheck(c, { decimals = null, symbol = '' } = {}) {
  const raw = String(c?.name ?? c?.check ?? '检查项');
  const name = displayName(raw);
  const ok = c?.ok !== false;
  const isAmount = AMOUNT_NAME_RE.test(raw);
  const unit = isAmount && Number.isInteger(decimals) ? symbol : '';
  const amt = (x) => `${formatAmount(x, decimals)}${unit ? ' ' + unit : ''}`;

  // R3: expected vs actual amount credited to the receiver.
  const rb = typeof c?.before === 'string' ? c.before.match(RECV_RE) : null;
  const ra = typeof c?.after === 'string' ? c.after.match(RECV_RE) : null;
  if (rb && ra) {
    const exp = BigInt(rb[1]);
    const got = BigInt(ra[1]);
    const d = got - exp;
    const sentence =
      d === 0n
        ? `持有人转出 ${amt(exp)}，收款地址足额到账`
        : `持有人转出 ${amt(exp)}，收款地址实际到账 ${amt(got)}（差额 ${amt(d < 0n ? -d : d)}，${pctText(exp, d)}）`;
    return { raw, name, ok, beforeText: amt(exp), afterText: amt(got), deltaText: d ? amt(d) : '', pctText: d ? pctText(exp, d) : '', sentence };
  }
  // R3B: a stranger must not move anyone else's funds (transferFrom without allowance, or any probe).
  if (/^R3B_/.test(raw)) {
    const after = String(c?.after ?? '');
    const n = after.match(/^(\d+) watched balance/);
    let sentence;
    if (ok) sentence = '陌生地址无法动用别人的余额';
    else if (/succeed|success|true/i.test(after)) sentence = '陌生地址在没有任何授权的情况下，用 transferFrom 转走了持有人的余额';
    else if (n) sentence = `陌生地址的调用改变了 ${n[1]} 个受监控地址的余额`;
    else sentence = '陌生地址的调用改变了别人的余额';
    return { raw, name, ok, beforeText: '', afterText: ok ? '未改动' : '被改动', deltaText: '', pctText: '', sentence };
  }
  // R9: new dangerous opcodes compared with the current implementation.
  if (/^R9_/.test(raw)) {
    const added = addedOpcodes(c?.before, c?.after);
    const sentence = ok
      ? '新实现没有新增危险操作码'
      : added.length
        ? `新实现比旧实现多了 ${added.length} 个危险操作码（${added.join('、')}）`
        : '新实现包含旧实现没有的危险操作码';
    return { raw, name, ok, beforeText: '', afterText: added.join('、'), deltaText: '', pctText: '', sentence, opcodes: added };
  }
  // R4: liveness flag.
  if (/^R4_/.test(raw) || (c?.before === 'transfer' && typeof c?.after === 'string')) {
    const success = /^(success|ok|true)$/i.test(String(c?.after));
    const sentence = success ? '持有人的正常转账可以完成' : `持有人的正常转账失败（${String(c?.after ?? '').slice(0, 40)}）`;
    return { raw, name, ok, beforeText: '', afterText: success ? '成功' : '失败', deltaText: '', pctText: '', sentence };
  }

  const b = valueText(c?.before, isAmount ? decimals : null, unit);
  const a = valueText(c?.after, isAmount ? decimals : null, unit);
  let deltaText = '';
  let pct = '';
  if (b.num !== null && a.num !== null) {
    const d = a.num - b.num;
    if (d !== 0n) {
      deltaText = `${d > 0n ? '+' : ''}${formatAmount(d, isAmount ? decimals : null)}${unit ? ' ' + unit : ''}`;
      pct = pctText(b.num, d);
    }
  }
  let sentence;
  if (b.text === a.text && !deltaText) sentence = `${name} 保持 ${a.text}`;
  else {
    sentence = `${name} 从 ${b.text} 变为 ${a.text}`;
    // A huge jump reads better as a multiple than as an absolute delta.
    if (pct.startsWith('约为原来的')) sentence += `（${pct}）`;
    else if (deltaText) sentence += `（${deltaText}${pct ? '，' + pct : ''}）`;
  }
  sentence = sentence.replace(/(从|变为|保持|（\+?-?) 约 /g, '$1约 ');
  return { raw, name, ok, beforeText: b.text, afterText: a.text, deltaText, pctText: pct, sentence };
}

/**
 * @param sim       aggregated sim_result event
 * @param proposal  matching proposal_seen event (may be null)
 * @param opts      { decimals, symbol, sentinelsAgreeing }
 */
export function buildFacts(sim, proposal, opts = {}) {
  const { decimals = null, symbol = 'dBTC' } = opts;
  const verdict = sim?.verdict === 'veto' ? 'veto' : 'pass';
  let ruleId = normalizeRuleId(sim?.rule);
  if (verdict === 'pass') ruleId = 'pass';
  // A veto must always name a rule; an unknown/missing one gets the generic veto template.
  if (verdict === 'veto' && (!ruleId || ruleId === 'pass')) ruleId = 'UNKNOWN';
  const kind = normalizeKind(proposal?.kind ?? sim?.kind ?? sim?.extra?.kind);
  const target = proposal?.target ?? sim?.target ?? sim?.extra?.target ?? null;
  const codehash = proposal?.codehash ?? sim?.codehash ?? sim?.extra?.codehash ?? null;
  const checks = Array.isArray(sim?.checks) ? sim.checks.map((c) => describeCheck(c, { decimals, symbol })) : [];
  const failed = checks.filter((c) => !c.ok);
  const selectorsAdded = Array.isArray(sim?.selectorsAdded) ? sim.selectorsAdded.map(String) : [];
  const simMs = Number.isFinite(Number(sim?.simMs)) ? Math.round(Number(sim.simMs)) : null;
  const ex = sim?.extra && typeof sim.extra === 'object' ? sim.extra : {};
  const culprits = (Array.isArray(ex.culprits) ? ex.culprits : [])
    .filter((c) => c && typeof c.selector === 'string')
    .slice(0, 3)
    .map((c) => ({ selector: c.selector, effects: Array.isArray(c.effects) ? c.effects.map(String) : [] }));
  const unitSym = Number.isInteger(decimals) ? ' ' + symbol : '';
  const skimmedTo = (Array.isArray(ex.skimmedTo) ? ex.skimmedTo : [])
    .map((x) => ({ address: x?.address, delta: toBigIntOrNull(x?.delta) }))
    .filter((x) => typeof x.address === 'string' && x.delta !== null)
    .slice(0, 2)
    .map((x) => ({ ...x, text: `${shortHex(x.address)}（${x.delta > 0n ? '+' : ''}${formatAmount(x.delta, decimals)}${unitSym}）` }));
  const selectorsRemoved = Array.isArray(ex.selectorsRemoved) ? ex.selectorsRemoved.map(String) : [];
  // R3B attribution: watched balances changed by stranger calls (extra.thirdPartyDeltas).
  const thirdParty = (Array.isArray(ex.thirdPartyDeltas) ? ex.thirdPartyDeltas : [])
    .map((x) => ({ address: x?.address, delta: toBigIntOrNull(x?.delta) }))
    .filter((x) => typeof x.address === 'string' && x.delta !== null && x.delta !== 0n);
  const thirdPartyShown = thirdParty
    .slice(0, 2)
    .map((x) => ({ ...x, text: `${shortHex(x.address)}（${x.delta > 0n ? '+' : ''}${formatAmount(x.delta, decimals)}${unitSym}）` }));
  // R9: new dangerous opcodes, from extra (any of a few plausible names) or from the R9 check itself.
  const r9 = checks.find((c) => /^R9_/.test(c.raw) && Array.isArray(c.opcodes) && c.opcodes.length);
  const opcodesAdded = [
    ...new Set(
      [ex.opcodesAdded, ex.newOpcodes, ex.dangerousOpcodesAdded, ex.opcodes?.added]
        .flatMap((v) => opcodeList(v))
        .concat(r9 ? r9.opcodes : []),
    ),
  ].sort();
  const errorText = [sim?.error, sim?.extra?.error, sim?.extra?.detail, sim?.extra?.reason]
    .find((x) => typeof x === 'string' && x.trim()) ?? '';

  const f = {
    id: String(sim?.id ?? proposal?.id ?? '?'),
    mode: sim?.mode ?? proposal?.mode ?? 'replay',
    verdict,
    ruleId,
    ruleLabel: RULE_LABELS[ruleId] ?? '未知规则',
    rawRule: sim?.rule == null ? '' : String(sim.rule).slice(0, 60),
    ruleHash: sim?.ruleHash ?? null,
    kind,
    kindLabel: kind === null ? '未知类型' : KIND_LABELS[kind],
    target,
    targetShort: target ? shortHex(target) : '',
    codehash,
    codehashShort: codehash ? shortHex(codehash, 8, 4) : '',
    proposeBlock: proposal?.proposeBlock ?? null,
    readyBlock: proposal?.readyBlock ?? null,
    checks,
    failed,
    checkCount: checks.length,
    selectorsAdded,
    selectorsText: selectorsAdded.length
      ? selectorsAdded.slice(0, 4).join('、') + (selectorsAdded.length > 4 ? ` 等 ${selectorsAdded.length} 个` : '')
      : '',
    simMs,
    culprits,
    // 同一个选择器可能对应多个观察（例如 owner 与 totalSupply 都变了），句子里只列一次
    culpritText: [...new Set(culprits.map((c) => c.selector))].join('、'),
    skimmedTo,
    skimText: skimmedTo.map((x) => x.text).join('、'),
    selectorsRemoved,
    thirdParty: thirdPartyShown,
    thirdPartyCount: thirdParty.length,
    thirdPartyText: thirdPartyShown.map((x) => x.text).join('、'),
    opcodesAdded,
    opcodesText: opcodesAdded.slice(0, 5).join('、') + (opcodesAdded.length > 5 ? ` 等 ${opcodesAdded.length} 个` : ''),
    errorText: errorText.slice(0, 120),
    symbol,
  };
  f.lines = factLines(f);
  return f;
}

function factLines(f) {
  const L = [];
  L.push(`提案编号：#${f.id}`);
  L.push(`提案类型：${f.kindLabel}`);
  if (f.targetShort) L.push(`目标地址：${f.targetShort}`);
  const implKind = f.kind === null || f.kind === 0;
  if (f.codehashShort && (implKind || f.kind === 3)) L.push(`${f.kind === 3 ? '新暂停实现' : '新实现'} codehash：${f.codehashShort}`);
  const pb = toBigIntOrNull(f.proposeBlock);
  const rb = toBigIntOrNull(f.readyBlock);
  if (pb !== null && rb !== null && rb >= pb) {
    L.push(`冷静期：${rb - pb} 个区块（第 ${pb} 块提案，第 ${rb} 块起才能执行）`);
  }
  L.push(`哨兵判定：${f.verdict === 'veto' ? '否决' : '放行'}`);
  if (f.verdict === 'veto') L.push(`违反的规则：${f.ruleId === 'UNKNOWN' ? f.rawRule || '未注明' : f.ruleId}（${f.ruleLabel}）`);
  if (implKind) {
    L.push(
      f.selectorsAdded.length
        ? `新实现相比旧实现新增的函数选择器：${f.selectorsText}`
        : '新实现相比旧实现没有新增函数选择器（选择器完全相同）',
    );
  }
  if (f.selectorsRemoved.length) L.push(`新实现删除的函数选择器：${f.selectorsRemoved.slice(0, 4).join('、')}`);
  for (const c of f.checks) L.push(`检查「${c.raw}」：${c.sentence}，${c.ok ? '通过' : '违反'}`);
  if (f.culprits.length) {
    L.push(`陌生地址调用后产生异常效果的函数选择器：${f.culprits.map((c) => `${c.selector}（${c.effects.join('/') || '异常'}）`).join('、')}`);
  }
  if (f.skimmedTo.length) L.push(`转账中多出的金额流向：${f.skimText}`);
  if (f.thirdPartyCount) L.push(`陌生地址调用后余额被改动的地址（共 ${f.thirdPartyCount} 个）：${f.thirdPartyText}`);
  if (f.opcodesAdded.length) L.push(`新实现新增的危险操作码（共 ${f.opcodesAdded.length} 个）：${f.opcodesText}`);
  if (f.errorText) L.push(`模拟错误信息：${f.errorText}`);
  if (f.simMs !== null) L.push(`模拟耗时：${f.simMs} 毫秒`);
  return L;
}
