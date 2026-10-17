// Attack simulation (spec 4.2): one merged eth_simulateV1 request per proposal per sentinel.
// The proxy's ERC-1967 implementation slot is overridden (stateDiff, other storage kept) with the
// proposed implementation, then inside a single simulated block:
//   baseline reads -> holder transfer (R3/R4) -> reads -> stranger transferFrom (R3B) ->
//   stranger probes (R1/R2/R3B) -> reads (totalSupply, owner, every watched balance).
// State carries over between calls of the same simulated block (verified before the event).
import { decodeFunctionResult, encodeFunctionData, keccak256, numberToHex, pad, stringToBytes, toHex, decodeEventLog } from 'viem'
import { extractSelectors } from './bytecode.mjs'

// ERC1967Utils.IMPLEMENTATION_SLOT is defined by OpenZeppelin as
// bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1); derive it the same way.
export const IMPLEMENTATION_SLOT = numberToHex(BigInt(keccak256(stringToBytes('eip1967.proxy.implementation'))) - 1n, { size: 32 })
if (IMPLEMENTATION_SLOT !== '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc') {
  throw new Error('ERC-1967 implementation slot derivation mismatch')
}

const BIG = 2n ** 128n
const randomAddress = () => toHex(crypto.getRandomValues(new Uint8Array(20)))
const word = (x) => pad(typeof x === 'bigint' ? numberToHex(x) : x, { size: 32 }).slice(2)

// Generic argument sets from spec 4.2: none, stranger, stranger + big, big, plus a wide set of 8
// words (stranger, big, big, stranger, 0, 0, 0, 0) so that 3+ argument backdoors (rescue(to, amount,
// memo)) decode instead of reverting in the ABI decoder.
export const PROBES_PER_SELECTOR = 5
export const FALLBACK_PROBES = 2
export function probeCalldata(selector, stranger) {
  return [
    { args: 'none', data: selector },
    { args: 'addr', data: selector + word(stranger) },
    { args: 'addr,big', data: selector + word(stranger) + word(BIG) },
    { args: 'big', data: selector + word(BIG) },
    { args: 'wide', data: selector + word(stranger) + word(BIG) + word(BIG) + word(stranger) + word(0n) + word(0n) + word(0n) + word(0n) },
  ]
}
// Fallback / receive probes: empty calldata and calldata with a random unknown selector.
export function fallbackCalldata(stranger, selectors = []) {
  let sel
  do sel = toHex(crypto.getRandomValues(new Uint8Array(4)))
  while (selectors.includes(sel))
  return [
    { args: 'empty', data: '0x' },
    { args: 'random', data: sel + word(stranger) + word(BIG) + word(BIG) },
  ]
}

export function implFromSlot(slotValue) {
  return ('0x' + (slotValue ?? '0x').slice(2).padStart(64, '0').slice(24)).toLowerCase()
}

/**
 * Build the merged simulation request.
 * @returns {{ params: any[], layout: object }}
 */
export function buildSimulation({ proxy, newImpl, newCode, holder, amount, watch, tokenAbi, callGas, readGas, maxCalls = 150 }) {
  const stranger = randomAddress()
  const receiver = randomAddress()
  const watchList = [...new Set([...watch.map((a) => a.toLowerCase()), holder.toLowerCase(), receiver])]
  const calls = []
  const layout = { stranger, receiver, watchList, amount, holder: holder.toLowerCase() }
  const read = (fn, args = [], tag) => {
    calls.push({ from: stranger, to: proxy, data: encodeFunctionData({ abi: tokenAbi, functionName: fn, args }), gas: numberToHex(readGas), _tag: tag, _fn: fn })
    return calls.length - 1
  }
  const readAll = (phase) => ({
    totalSupply: read('totalSupply', [], `${phase}:totalSupply`),
    owner: read('owner', [], `${phase}:owner`),
    balances: watchList.map((a) => read('balanceOf', [a], `${phase}:balance`)),
  })

  layout.r0 = readAll('before')
  layout.transfer = calls.length
  calls.push({
    from: holder,
    to: proxy,
    data: encodeFunctionData({ abi: tokenAbi, functionName: 'transfer', args: [receiver, amount] }),
    gas: numberToHex(callGas),
    _tag: 'transfer',
    _fn: 'transfer',
  })
  layout.r1 = readAll('afterTransfer')
  // R3B: a stranger without any allowance must not be able to pull the holder's funds.
  layout.transferFrom = calls.length
  calls.push({
    from: stranger,
    to: proxy,
    data: encodeFunctionData({ abi: tokenAbi, functionName: 'transferFrom', args: [holder, stranger, amount] }),
    gas: numberToHex(callGas),
    _tag: 'transferFrom',
    _fn: 'transferFrom',
  })

  const selectors = extractSelectors(newCode)
  layout.selectors = selectors
  layout.probes = []
  const reserve = 2 + watchList.length // final reads
  const wanted = [
    ...selectors.flatMap((sel) => probeCalldata(sel, stranger).map((p) => ({ selector: sel, ...p }))),
    ...fallbackCalldata(stranger, selectors).map((p) => ({ selector: 'fallback', ...p })),
  ]
  for (const p of wanted) {
    if (calls.length + reserve >= maxCalls) break
    layout.probes.push({ index: calls.length, selector: p.selector, args: p.args })
    calls.push({ from: stranger, to: proxy, data: p.data, gas: numberToHex(callGas), _tag: 'probe' })
  }
  // Not every probe fits under SIM_MAX_CALLS: the caller must fail closed (R6), never pass.
  layout.truncated = layout.probes.length < wanted.length
  layout.wantedProbes = wanted.length
  layout.r2 = readAll('final')

  const stateOverrides = { [proxy]: { stateDiff: { [IMPLEMENTATION_SLOT]: pad(newImpl.toLowerCase(), { size: 32 }) } } }
  // Note: no `validation` field at all (Monad RPCs reject validation:false with -32000), and every
  // call carries an explicit gas (simulated gasUsed echoes the limit and is never used for gas.json).
  const params = [{ blockStateCalls: [{ stateOverrides, calls: calls.map(({ _tag, _fn, ...c }) => c) }] }, 'latest']
  layout.calls = calls
  return { params, layout }
}

export class ViewRevert extends Error {}

/** Evaluate the simulation result against R1-R4. Throws ViewRevert (-> R6) if a read reverted. */
export function evaluateSimulation(result, layout, { tokenAbi, oldSelectors }) {
  const block = Array.isArray(result) ? result[0] : result
  const res = block?.calls
  if (!Array.isArray(res) || res.length !== layout.calls.length) throw new ViewRevert(`unexpected simulate result shape (${res?.length} calls)`)
  const ok = (i) => res[i].status === '0x1' || res[i].status === 1 || res[i].status === '1'
  const readVal = (i) => {
    if (!ok(i)) throw new ViewRevert(`view ${layout.calls[i]._tag} reverted${res[i].error?.message ? ': ' + res[i].error.message : ''}`)
    return decodeFunctionResult({ abi: tokenAbi, functionName: layout.calls[i]._fn, data: res[i].returnData })
  }
  const snap = (r) => ({
    totalSupply: readVal(r.totalSupply),
    owner: readVal(r.owner).toLowerCase(),
    balances: r.balances ? r.balances.map(readVal) : null,
  })
  const s0 = snap(layout.r0)
  const s1 = snap(layout.r1)
  const s2 = snap(layout.r2)

  // R4: the plain holder transfer must succeed (and return true if it returns anything).
  const t = res[layout.transfer]
  let transferOk = ok(layout.transfer)
  if (transferOk && t.returnData && t.returnData !== '0x') {
    try {
      transferOk = decodeFunctionResult({ abi: tokenAbi, functionName: 'transfer', data: t.returnData }) === true
    } catch {
      transferOk = false
    }
  }

  // R3: holder -X, receiver +X, everyone else on the watchlist unchanged, totalSupply unchanged.
  const X = layout.amount
  const deltas = layout.watchList.map((a, k) => ({ a, d: s1.balances[k] - s0.balances[k] }))
  const conservation = transferOk && deltas.every(({ a, d }) =>
    a === layout.holder ? d === -X : a === layout.receiver ? d === X : d === 0n) && s1.totalSupply === s0.totalSupply
  const recvIdx = layout.watchList.indexOf(layout.receiver)

  const checks = [
    { name: 'R1_TOTAL_SUPPLY', before: s1.totalSupply, after: s2.totalSupply, ok: s2.totalSupply === s1.totalSupply },
    { name: 'R2_OWNER', before: s0.owner, after: s2.owner, ok: s2.owner === s0.owner },
    {
      name: 'R3_TRANSFER_CONSERVATION',
      before: `receiver+${X}`,
      after: `receiver+${s1.balances[recvIdx] - s0.balances[recvIdx]}`,
      ok: conservation,
    },
    { name: 'R4_TRANSFER_LIVENESS', before: 'transfer', after: transferOk ? 'success' : 'reverted', ok: transferOk },
  ]

  // R3B: transferFrom(holder, stranger, X) from a stranger with no allowance must revert (or return
  // false), and no stranger call (that one or any probe) may change anyone's watched balance.
  let pulled = false
  if (layout.transferFrom != null) {
    const tf = res[layout.transferFrom]
    if (ok(layout.transferFrom)) {
      pulled = true
      if (tf.returnData && tf.returnData !== '0x') {
        try {
          pulled = decodeFunctionResult({ abi: tokenAbi, functionName: 'transferFrom', data: tf.returnData }) !== false
        } catch {
          pulled = true
        }
      }
    }
  }
  const touched = s2.balances
    ? layout.watchList.map((a, k) => ({ address: a, delta: s2.balances[k] - s1.balances[k] })).filter(({ delta }) => delta !== 0n)
    : []
  checks.push({
    name: 'R3B_THIRD_PARTY_FUNDS',
    before: 'transferFrom(holder, stranger) without allowance',
    after: pulled ? 'succeeded' : touched.length ? `${touched.length} watched balance(s) changed by stranger calls` : 'reverted, balances unchanged',
    ok: !pulled && touched.length === 0,
  })

  // Attribution from the logs of the same request (free): which stranger probe minted/burned or
  // moved ownership. Used by the report, never by the verdict.
  const culprits = []
  for (const p of layout.probes) {
    const r = res[p.index]
    if (!ok(p.index)) continue
    const effects = []
    for (const lg of r.logs ?? []) {
      try {
        const ev = decodeEventLog({ abi: tokenAbi, data: lg.data, topics: lg.topics })
        if (ev.eventName === 'Transfer' && (BigInt(ev.args.from) === 0n || BigInt(ev.args.to) === 0n)) effects.push('supply')
        if (ev.eventName === 'OwnershipTransferred') effects.push('owner')
        if (ev.eventName === 'Transfer' && BigInt(ev.args.from) !== 0n && ev.args.from.toLowerCase() !== layout.stranger) effects.push('moved-others-funds')
      } catch {}
    }
    if (effects.length) culprits.push({ selector: p.selector, args: p.args, effects: [...new Set(effects)] })
  }
  // Fee skim attribution for R3: who received value besides the receiver.
  const skimmedTo = deltas.filter(({ a, d }) => a !== layout.holder && a !== layout.receiver && d !== 0n).map(({ a, d }) => ({ address: a, delta: d }))

  const old = new Set(oldSelectors ?? [])
  const selectorsAdded = layout.selectors.filter((s) => !old.has(s))
  const selectorsRemoved = (oldSelectors ?? []).filter((s) => !layout.selectors.includes(s))

  // Priority when several invariants break: liveness, conservation, owner, supply, third-party funds.
  const order = ['R4_TRANSFER_LIVENESS', 'R3_TRANSFER_CONSERVATION', 'R2_OWNER', 'R1_TOTAL_SUPPLY', 'R3B_THIRD_PARTY_FUNDS']
  const failed = order.find((n) => !checks.find((c) => c.name === n).ok) ?? null
  return {
    verdict: failed ? 'veto' : 'pass',
    rule: failed,
    checks,
    selectorsAdded,
    extra: { selectorsRemoved, culprits, skimmedTo, thirdPartyDeltas: touched, probes: layout.probes.length, truncated: layout.truncated, calls: layout.calls.length },
  }
}
