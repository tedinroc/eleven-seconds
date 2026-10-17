// Cloud sentinel judgment: the same decision the live sentinel makes (sentinel/src/main.mjs judge()),
// built from the sentinel's own pure modules (bytecode scan, simulation request builder, rule
// evaluation, approval keys) over a fetch-based RPC. Rules R1-R4, R3B (simulation), R5 (strict),
// R6 (fail-closed), R7 (config kinds), R8 (init data), R9 (new dangerous opcodes).
import { decodeFunctionResult, encodeFunctionData, keccak256 } from 'viem'
import { buildSimulation, evaluateSimulation, implFromSlot, IMPLEMENTATION_SLOT, ViewRevert } from '../../../sentinel/src/simulate.mjs'
import { extractSelectors, dangerousOpcodes } from '../../../sentinel/src/bytecode.mjs'
import { approvalKeyFor, upgradeDataKey } from '../../../sentinel/src/keys.mjs'
import { isRetryable } from './rpc.mjs'

const lc = (a) => (a ? String(a).toLowerCase() : a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Shared, per-proposal context: everything that is the same for the three sentinels. */
export function makeChainView({ read, D, abis }) {
  // One view per proposal: the three sentinels share its reads (promise memo, failures not kept), so
  // a judgment costs a handful of subrequests instead of three times as many.
  const memo = new Map()
  const once = (key, fn) => {
    if (!memo.has(key)) memo.set(key, fn().catch((e) => {
      memo.delete(key)
      throw e
    }))
    return memo.get(key)
  }
  const implInfo = new Map()
  const ethCall = async (to, abi, functionName, args = []) => {
    const data = encodeFunctionData({ abi, functionName, args })
    const ret = await once(`call:${lc(to)}:${data}`, () => read.call('eth_call', [{ to, data }, 'latest']))
    return decodeFunctionResult({ abi, functionName, data: ret })
  }
  const getCode = (addr) => once(`code:${lc(addr)}`, () => read.call('eth_getCode', [lc(addr), 'latest']))
  const currentImpl = async () => implFromSlot(await once('slot', () => read.call('eth_getStorageAt', [D.proxy, IMPLEMENTATION_SLOT, 'latest'])))
  const currentImplInfo = async () => {
    const impl = await currentImpl()
    if (!implInfo.has(impl)) {
      const code = await getCode(impl)
      if (!code || code === '0x') throw new Error(`current impl ${impl} has no code`)
      implInfo.set(impl, { impl, selectors: extractSelectors(code), ops: dangerousOpcodes(code) })
    }
    return implInfo.get(impl)
  }
  const isApproved = async (hash) => {
    if (!hash || BigInt(hash) === 0n) return false
    try {
      return await ethCall(D.guardedAdmin, abis.guardedAdmin, 'isApprovedCodehash', [hash])
    } catch {
      return false
    }
  }
  return { ethCall, getCode, currentImpl, currentImplInfo, isApproved }
}

// eth_simulateV1 over the simulation providers: first provider, then at most one retry on the next
// one (spec 4.2.2), within simBudgetMs. No `validation` field is ever sent (buildSimulation omits it).
async function simulate(sims, params, { simTimeoutMs, simBudgetMs }) {
  const deadline = Date.now() + simBudgetMs
  const errors = []
  for (const rpc of sims.slice(0, 2)) {
    const remaining = deadline - Date.now()
    if (remaining <= 50) break
    const t = Date.now()
    try {
      const result = await rpc.call('eth_simulateV1', params, { timeoutMs: Math.min(simTimeoutMs, remaining) })
      return { result, rpc: rpc.label, errors }
    } catch (e) {
      errors.push(`${rpc.label}: ${String(e.message).slice(0, 160)} (${Date.now() - t} ms)${isRetryable(e) ? ' transport' : ''}`)
    }
  }
  return { result: null, errors }
}

/**
 * Judge one proposal for one sentinel.
 * @param p      { id, kind, target, value, data, codehash }
 * @param view   makeChainView(...)
 * @param sims   ordered simulation clients for this sentinel
 */
export async function judge(p, { view, sims, D, abis, cfg }) {
  const t = Date.now()
  const kind = Number(p.kind)
  const veto = (rule, checks, extra = {}) => ({ verdict: 'veto', rule, checks, selectorsAdded: [], simMs: Date.now() - t, extra })
  const pass = (checks, extra = {}) => ({ verdict: 'pass', rule: null, checks, selectorsAdded: [], simMs: Date.now() - t, extra })

  if (kind === 1 || kind === 2 || kind === 3) {
    let weakening = true
    let what = ''
    if (kind === 1) what = BigInt(p.value) === 0n ? `remove guardian ${p.target}` : `add guardian ${p.target}`
    else if (kind === 2) {
      const cur = BigInt(await view.ethCall(D.guardedAdmin, abis.guardedAdmin, 'delayBlocks').catch(() => 2n ** 64n))
      weakening = BigInt(p.value) < cur
      what = `delay ${cur} -> ${p.value}`
    } else what = `paused impl -> ${p.target}`
    if (!weakening) return pass([{ name: 'R7_CONFIG_GUARD', before: what, after: 'not weakening', ok: true }])
    const key = approvalKeyFor(p)
    const approved = await view.isApproved(key)
    const check = { name: 'R7_CONFIG_GUARD', before: what, after: approved ? 'approved' : 'not approved', ok: approved }
    return approved ? pass([check], { approvalKey: key }) : veto('R7_CONFIG_GUARD', [check], { approvalKey: key })
  }

  const hasData = p.data && p.data !== '0x'
  const oldInfoP = view.currentImplInfo().catch(() => null)
  const dataKey = hasData ? upgradeDataKey(p.codehash, p.data) : null
  const [newCode, approved, dataApproved] = await Promise.all([
    view.getCode(p.target),
    cfg.strict ? view.isApproved(p.codehash) : Promise.resolve(false),
    hasData ? view.isApproved(dataKey) : Promise.resolve(false),
  ])
  if (cfg.strict && !approved) {
    return veto('R5_STRICT_CODEHASH', [{ name: 'R5_STRICT_CODEHASH', before: p.codehash, after: 'not approved', ok: false }])
  }
  if (hasData && !dataApproved) {
    return veto('R8_INIT_DATA', [{ name: 'R8_INIT_DATA', before: `${(p.data.length - 2) / 2} bytes init data`, after: 'codehash+data not approved', ok: false }], { approvalKey: dataKey })
  }
  if (!newCode || newCode === '0x' || keccak256(newCode) !== lc(p.codehash)) {
    return veto('R6_SIM_FAILURE', [{ name: 'R6_SIM_FAILURE', before: p.codehash, after: 'code missing or codehash mismatch', ok: false }])
  }
  let holder = null
  let bal = 0n
  for (const h of D.holders) {
    const b = BigInt(await view.ethCall(D.proxy, abis.token, 'balanceOf', [h]))
    if (b > 0n) {
      holder = h
      bal = b
      break
    }
  }
  if (!holder) return veto('R6_SIM_FAILURE', [{ name: 'R6_SIM_FAILURE', before: 'holders', after: 'every watched holder has balance 0', ok: false }])
  const amount = bal / 100n > 0n ? bal / 100n : 1n

  const { params, layout } = buildSimulation({
    proxy: D.proxy, newImpl: p.target, newCode, holder, amount, watch: [D.owner, ...(D.tokenOwner ? [D.tokenOwner] : []), ...D.holders],
    tokenAbi: abis.token, callGas: cfg.simCallGas, readGas: cfg.simReadGas, maxCalls: cfg.simMaxCalls,
  })
  if (layout.truncated) {
    return veto('R6_SIM_FAILURE', [{ name: 'R6_SIM_FAILURE', before: `${layout.wantedProbes} probes needed`, after: `only ${layout.probes.length} fit in ${cfg.simMaxCalls} calls`, ok: false }])
  }
  const simT = Date.now()
  const { result, rpc, errors } = await simulate(sims, params, cfg)
  const simRequestMs = Date.now() - simT
  const oldInfo = await oldInfoP
  if (!result) {
    return veto('R6_SIM_FAILURE', [{ name: 'R6_SIM_FAILURE', before: 'eth_simulateV1', after: `failed on ${errors.length} provider(s)`, ok: false }], { errors })
  }
  try {
    const r = evaluateSimulation(result, layout, { tokenAbi: abis.token, oldSelectors: oldInfo?.selectors ?? [] })
    const newOps = dangerousOpcodes(newCode)
    const addedOps = newOps.filter((o) => !(oldInfo?.ops ?? []).includes(o))
    if (r.verdict === 'pass' && addedOps.length) {
      const ok9 = approved || (await view.isApproved(p.codehash))
      r.checks.push({ name: 'R9_NEW_OPCODES', before: (oldInfo?.ops ?? []).join(' ') || 'none', after: `new: ${addedOps.join(' ')}${ok9 ? ' (codehash approved)' : ''}`, ok: ok9 })
      if (!ok9) {
        r.verdict = 'veto'
        r.rule = 'R9_NEW_OPCODES'
      }
      r.extra.newOpcodes = addedOps
    }
    return { ...r, simMs: Date.now() - t, extra: { ...r.extra, simRpc: rpc, simRequestMs, retried: errors.length > 0, ...(errors.length ? { errors } : {}), ...(oldInfo ? {} : { selectorsUnknown: true }) } }
  } catch (e) {
    if (e instanceof ViewRevert) {
      return veto('R6_SIM_FAILURE', [{ name: 'R6_SIM_FAILURE', before: 'view', after: String(e.message).slice(0, 160), ok: false }], { simRpc: rpc })
    }
    throw e
  }
}

/** Judge with the fail-closed wrapper the live sentinel uses (any exception -> R6). */
export async function judgeSafe(p, ctx, delayMs = 0) {
  if (delayMs) await sleep(delayMs)
  const t0 = Date.now()
  try {
    return await judge(p, ctx)
  } catch (e) {
    return { verdict: 'veto', rule: 'R6_SIM_FAILURE', checks: [{ name: 'R6_SIM_FAILURE', before: 'judge', after: String(e.message).slice(0, 160), ok: false }], selectorsAdded: [], simMs: Date.now() - t0, extra: {} }
  }
}
