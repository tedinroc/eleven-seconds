// Template reports (cached: true). One paragraph of Simplified Chinese per rule ID
// plus "pass". Used when LM Studio is down, slow, or its output fails the guards.
// Every number comes from facts.mjs; nothing here invents a figure.

function pick(f, re) {
  return f.failed.find((c) => re.test(c.name)) ?? null;
}

function failedSummary(f, max = 2, fallback = '') {
  const s = f.failed.slice(0, max).map((c) => c.sentence);
  return s.length ? s.join('；') : fallback;
}

function head(f) {
  return `提案 #${f.id}（${f.kindLabel}${f.targetShort ? '，目标 ' + f.targetShort : ''}）`;
}

const T = {
  R1_TOTAL_SUPPLY: (f) => {
    const c = pick(f, /supply|供应/i) ?? f.failed[0];
    return (
      `${head(f)}被哨兵否决：用陌生地址调用${f.culpritText ? ' ' + f.culpritText + ' ' : '新实现'}后，${c ? c.sentence : '总供应量发生了变化'}。` +
      `这说明任何人都能绕过权限凭空增发 ${f.symbol}，持有人的份额会被稀释，属于无权限增发型漏洞。` +
      `建议多签维持否决、不要执行，并检查提案密钥是否外泄，必要时轮换 owner。`
    );
  },
  R2_OWNER: (f) => {
    const c = pick(f, /owner/i) ?? f.failed[0];
    const sel = f.selectorsText ? `（新增函数选择器：${f.selectorsText}）` : '';
    return (
      `${head(f)}被哨兵否决：用陌生地址调用${f.culpritText ? ' ' + f.culpritText + ' ' : '新实现'}后，${c ? c.sentence : 'owner 发生了变化'}${sel}。` +
      `这意味着任何人都能夺走合约控制权，进而增发、冻结或再次升级。` +
      `建议多签维持否决，并尽快轮换 owner 密钥。`
    );
  },
  R3_TRANSFER_CONSERVATION: (f) => {
    const sel = f.selectorsAdded.length
      ? `新实现另外新增了 ${f.selectorsAdded.length} 个函数选择器`
      : '新实现的函数选择器与旧实现完全相同，只比对字节码签名的检查抓不到这种问题';
    return (
      `${head(f)}被哨兵否决：模拟持有人正常转账时，${failedSummary(f, 2, '转出与转入金额不一致')}${f.skimText ? '，差额流向 ' + f.skimText : ''}，转账前后不守恒。` +
      `${sel}，转账会被暗中抽成。` +
      `建议多签维持否决，要求提供源码并逐行审计转账逻辑。`
    );
  },
  R3B_THIRD_PARTY_FUNDS: (f) => {
    const c = pick(f, /^R3B_/) ?? f.failed[0];
    const who = f.thirdPartyText ? `（被改动：${f.thirdPartyText}）` : '';
    const sel = f.culpritText ? `，相关函数选择器 ${f.culpritText}` : '';
    return (
      `${head(f)}被哨兵否决：${c ? c.sentence : '陌生地址的调用改变了别人的余额'}${who}${sel}。` +
      `这说明任何人都可能不经授权挪走持有人的 ${f.symbol}，属于盗用第三方资金型漏洞。` +
      `建议多签维持否决、不要执行，要求提供源码并审计 transferFrom 与授权逻辑。`
    );
  },
  R9_NEW_OPCODES: (f) => {
    const n = f.opcodesAdded.length;
    const what = n ? `新实现比旧实现多了 ${n} 个危险操作码（${f.opcodesText}）` : '新实现包含旧实现没有的危险操作码';
    return (
      `${head(f)}被哨兵否决：${what}。` +
      `读取区块时间、区块号、tx.origin，或外部调用、自毁这类操作码，能让合约在模拟之后才改变行为（例如到某个区块才触发的定时炸弹），单靠模拟无法排除。` +
      `建议多签维持否决，要求说明每个新操作码的用途，经 approver 核准 codehash 后再提案。`
    );
  },
  R4_TRANSFER_LIVENESS: (f) => {
    const why = f.errorText ? `（${f.errorText}）` : '';
    return (
      `${head(f)}被哨兵否决：持有人的正常转账在新实现下失败${why}。` +
      `一旦执行，${f.symbol} 将无法转账，相当于把代币升级成“砖头”。` +
      `建议多签维持否决，请开发方修复后重新提案。`
    );
  },
  R5_STRICT_CODEHASH: (f) =>
    `${head(f)}被哨兵否决：严格模式下，新实现 codehash ${f.codehashShort || '（未提供）'} 尚未经 approver 预先核准。` +
    `模拟只能覆盖已知攻击面，无法排除只对特定地址或特定区块才生效的后门。` +
    `建议 approver 审阅源码与构建产物、核准 codehash 后再重新提案。`,
  R6_SIM_FAILURE: (f) => {
    const why = f.errorText ? `（${f.errorText}）` : '';
    return (
      `${head(f)}被哨兵否决：对新实现的模拟失败或超时${why}，按 fail-closed 原则处理。` +
      `这不代表新实现一定有恶意，但在无法验证的情况下放行风险更高。` +
      `建议检查模拟 RPC 状况后重新提案，或由多签人工审阅新实现。`
    );
  },
  R7_CONFIG_GUARD: (f) => {
    const c = f.failed[0];
    const raw = c ? `${c.beforeText} ${c.afterText}` : '';
    let what;
    if (f.kind === 1) {
      const verb = /remove|移除|disable|false|0$/i.test(c?.afterText ?? '') ? '移除' : /add|enable|新增|true/i.test(raw) ? '新增' : '变更';
      what = `${verb}守护者${f.targetShort ? ' ' + f.targetShort : ''}`;
    } else if (f.kind === 2) {
      const nums = c && /^\d[\d,]*$/.test(c.beforeText) && /^\d[\d,]*$/.test(c.afterText);
      what = nums ? `把冷静期从 ${c.beforeText} 个区块改为 ${c.afterText} 个区块` : '修改冷静期';
    } else if (f.kind === 3) {
      what = `把暂停实现更换为 ${f.targetShort || '新地址'}`;
    } else {
      what = '修改安全配置';
    }
    return (
      `${head(f)}被哨兵否决：该提案要${what}，且未经 approver 核准。` +
      `移除守护者、缩短冷静期或换掉暂停实现，是在升级前先削弱防线的典型步骤。` +
      `建议多签维持否决；若确属运维需要，先由 approver 核准再重新提案。`
    );
  },
  R8_INIT_DATA: (f) =>
    `${head(f)}被哨兵否决：升级附带了非空的初始化数据，且新实现 codehash 未经 approver 核准。` +
    `初始化数据会在升级的同一笔交易里执行任意调用，可能夹带转移资产或修改权限的操作。` +
    `建议多签维持否决，要求提案方公开数据内容与用途，经 approver 核准后再提案。`,
  UNKNOWN: (f) =>
    `${head(f)}被哨兵依据规则 ${f.rawRule || '（未注明）'} 否决${f.failed.length ? '：' + failedSummary(f, 2) : ''}。` +
    `在原因查清之前执行该升级存在风险。` +
    `建议多签维持否决，核对哨兵日志与新实现源码后再决定是否重新提案。`,
  pass: (f) => {
    const kept = f.checks.filter((c) => c.ok).slice(0, 2).map((c) => c.sentence);
    const sel = f.selectorsText ? `，新增函数选择器 ${f.selectorsText}` : '';
    const summary = kept.length
      ? `${kept.join('，')}${sel}`
      : `陌生地址调用未改变总供应量和 owner，持有人转账守恒且能正常完成${sel}`;
    const n = f.checkCount ? `全部 ${f.checkCount} 项` : '全部';
    return (
      `${head(f)}通过了哨兵${n}检查：${summary}。` +
      `按规则予以放行，冷静期满后即可执行。` +
      `提醒：模拟发现不了只对特定地址或特定区块才生效的后门，正式环境建议开启严格模式，由 approver 预先核准 codehash。`
    );
  },
};

export function templateReport(f) {
  const fn = T[f.ruleId] ?? (f.verdict === 'pass' ? T.pass : T.UNKNOWN);
  return fn(f);
}

export const TEMPLATE_RULES = Object.keys(T);
