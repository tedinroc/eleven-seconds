#!/usr/bin/env node
// One sentinel process (spec section 4). Start three of them with different SENTINEL_INDEX /
// KEY_FILE / RPC_URL / SSE_PORT (see run.sh). Settings: src/config.mjs and NOTES.md.
import { readFileSync, existsSync } from 'node:fs'
import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts'
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, encodeAbiParameters, keccak256, numberToHex, pad, toEventSelector } from 'viem'
import { loadConfig } from './config.mjs'
import { loadAbis } from './abi.mjs'
import { loadRules } from './rules.mjs'
import { createRpc, RpcError } from './rpc.mjs'
import { createEventServer } from './sse.mjs'
import { Vetoer, readGasLimits } from './vetoer.mjs'
import { buildSimulation, evaluateSimulation, implFromSlot, IMPLEMENTATION_SLOT, ViewRevert } from './simulate.mjs'
import { extractSelectors } from './bytecode.mjs'
import { makeLogger, sleep, retry } from './util.mjs'

const cfg = loadConfig()
const log = makeLogger(cfg.source)

// ---------------------------------------------------------------- static inputs
if (!existsSync(cfg.deploymentsPath)) throw new Error(`deployments file not found (DEPLOYMENTS): ${cfg.deploymentsPath}`)
const dep = JSON.parse(readFileSync(cfg.deploymentsPath, 'utf8'))
const lc = (a) => (a ? String(a).toLowerCase() : a)
const D = {
  chainId: Number(cfg.chainId ?? dep.chainId),
  guardedAdmin: lc(dep.guardedAdmin),
  proxy: lc(dep.proxy),
  owner: lc(dep.owner),
  holders: (dep.holders ?? []).map((h) => lc(typeof h === 'string' ? h : h.address)),
  deployBlock: Number(dep.deployBlock ?? 0),
}
if (!D.guardedAdmin || !D.proxy || !D.chainId) throw new Error('deployments file must have chainId, guardedAdmin, proxy')
if (!D.holders.length) throw new Error('deployments file must list holders (needed for R3/R4)')

const abis = loadAbis(cfg.sharedDir, log)
const rules = loadRules(cfg.rulesPath, log)
const gasLimits = readGasLimits(existsSync(cfg.gasPath) ? JSON.parse(readFileSync(cfg.gasPath, 'utf8')) : null, log)
const PROPOSED_TOPIC = toEventSelector('Proposed(uint256,uint8,address,uint256,bytes,bytes32,uint64)')

// ---------------------------------------------------------------- RPC clients (created once, kept warm)
const main = createRpc(cfg.rpcUrl, { timeoutMs: cfg.rpcTimeoutMs })
const sims = cfg.simRpcs.map((u) => createRpc(u, { timeoutMs: cfg.simTimeoutMs }))
// Spread the three sentinels over the simulation providers: primary = (index-1) mod n.
const simOrder = sims.map((_, k) => sims[(cfg.index - 1 + k) % sims.length])
const broadcastRpcs = cfg.broadcastRpcs.map((u) => (u === cfg.rpcUrl ? main : sims.find((s) => s.url === u) ?? createRpc(u, { timeoutMs: 5_000 })))

const chainIdOnRpc = Number(await retry(() => main.call('eth_chainId'), { log, what: 'eth_chainId' }))
if (chainIdOnRpc !== D.chainId) throw new Error(`RPC chainId ${chainIdOnRpc} != deployments chainId ${D.chainId}`)

function loadAccount() {
  if (cfg.keyFile) {
    const raw = readFileSync(cfg.keyFile, 'utf8').trim()
    const pk = raw.startsWith('0x') ? raw : `0x${raw}`
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error('KEY_FILE does not contain a 32-byte hex private key')
    return privateKeyToAccount(pk)
  }
  // Anvil's built-in public test accounts only (well-known default mnemonic), never on a real chain.
  if (D.chainId !== 31337 || cfg.network !== 'anvil') throw new Error('ANVIL_ACCOUNT refused: not an anvil chain')
  return mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: Number(cfg.anvilAccount) })
}
const account = loadAccount()

// ---------------------------------------------------------------- local helpers
const ethCall = async (to, abi, functionName, args = []) => {
  const data = encodeFunctionData({ abi, functionName, args })
  const ret = await main.call('eth_call', [{ to, data }, 'latest'])
  return decodeFunctionResult({ abi, functionName, data: ret })
}
const codeCache = new Map()
const getCode = async (addr) => {
  const k = lc(addr)
  if (!codeCache.has(k)) codeCache.set(k, await main.call('eth_getCode', [k, 'latest']))
  return codeCache.get(k)
}
const isApproved = async (hash) => {
  if (!hash || BigInt(hash) === 0n) return false
  try {
    return await ethCall(D.guardedAdmin, abis.guardedAdmin, 'isApprovedCodehash', [hash])
  } catch (e) {
    log.warn(`isApprovedCodehash read failed (treated as not approved): ${e.message}`)
    return false
  }
}
// Config proposals carry codehash 0; their approval key is keccak256(abi.encode(kind, target, value)).
const actionHash = (kind, target, value) =>
  keccak256(encodeAbiParameters([{ type: 'uint8' }, { type: 'address' }, { type: 'uint256' }], [kind, target, value]))

// ---------------------------------------------------------------- state
const state = {
  lastBlock: 0,
  lastPollOk: 0,
  lastWsHead: 0,
  wsConnected: false,
  holderBalance: new Map(),
  delayBlocks: null,
  nextId: null,
  duplicates: 0,
}
const seen = new Map() // proposal id -> { t0, proposeBlock, blockHash, vetoTx, ... }
const pendingFinality = [] // { kind: 'veto'|'proposal', ... }

// ---------------------------------------------------------------- SSE / control server
const vetoer = new Vetoer({
  account, chainId: D.chainId, guardedAdmin: D.guardedAdmin, abi: abis.guardedAdmin, gasLimits, mainRpc: main,
  broadcastRpcs, rules, log, feeRefreshMs: cfg.feeRefreshMs, dryRun: cfg.dryRun,
})

const server = createEventServer({
  port: cfg.ssePort,
  source: cfg.source,
  mode: cfg.mode,
  log,
  health: () => ({
    ok: healthy(), source: cfg.source, mode: cfg.mode, lastBlock: state.lastBlock, rpc: main.label, ws: state.wsConnected,
    guardian: account.address, nonce: vetoer.nonce, strict: cfg.strict, dryRun: cfg.dryRun, proposalsSeen: seen.size, duplicatesDropped: state.duplicates,
  }),
  onAttach: cfg.attach ? handleAttach : null,
})
const emit = (type, fields) => server.emit(type, fields)
const healthy = () => Date.now() - Math.max(state.lastPollOk, state.lastWsHead) < 2_000

async function handleAttach(body) {
  const id = Number(body?.id)
  const reportHash = body?.reportHash
  if (!Number.isInteger(id) || id <= 0 || !/^0x[0-9a-fA-F]{64}$/.test(reportHash ?? '')) return { ok: false, error: 'need id (int) and reportHash (bytes32 hex)' }
  try {
    const tx = await vetoer.send('attachReason', [BigInt(id), reportHash])
    emit('reason_attached', { id, txHash: tx.txHash, reportHash })
    tx.receipt.then((r) => r && log.info(`attachReason #${id} mined in ${Number(r.blockNumber)} status ${r.status}`)).catch((e) => log.warn(`attachReason receipt: ${e.message}`))
    return { ok: true, id, txHash: tx.txHash }
  } catch (e) {
    log.error(`attachReason #${id}: ${e.message}`)
    return { ok: false, error: e.message }
  }
}

// ---------------------------------------------------------------- simulation with provider failover
async function simulate(params) {
  const deadline = Date.now() + cfg.simBudgetMs
  const errors = []
  for (const rpc of simOrder.slice(0, 2)) {
    const remaining = deadline - Date.now()
    if (remaining <= 50) break
    const t = Date.now()
    try {
      const result = await rpc.call('eth_simulateV1', params, { timeoutMs: Math.min(cfg.simTimeoutMs, remaining) })
      return { result, rpc: rpc.label, errors }
    } catch (e) {
      errors.push(`${rpc.label}: ${e.message.slice(0, 160)} (${Date.now() - t} ms)`)
      log.warn(`simulate on ${rpc.label} failed${e instanceof RpcError && e.retryable ? ' (retryable)' : ''}: ${e.message.slice(0, 200)}`)
    }
  }
  return { result: null, errors }
}

// ---------------------------------------------------------------- judging one proposal
async function judge(p) {
  const t = Date.now()
  const kind = Number(p.kind)
  const veto = (rule, checks, extra = {}) => ({ verdict: 'veto', rule, checks, selectorsAdded: [], simMs: Date.now() - t, extra })
  const pass = (checks, extra = {}) => ({ verdict: 'pass', rule: null, checks, selectorsAdded: [], simMs: Date.now() - t, extra })

  if (kind === 1 || kind === 2 || kind === 3) {
    // R7: guard-weakening config changes need an approver pre-approval.
    let weakening = false
    let what = ''
    if (kind === 1) {
      weakening = BigInt(p.value) === 0n
      what = weakening ? `remove guardian ${p.target}` : `add guardian ${p.target}`
    } else if (kind === 2) {
      const cur = state.delayBlocks ?? BigInt(await ethCall(D.guardedAdmin, abis.guardedAdmin, 'delayBlocks').catch(() => 2n ** 64n))
      weakening = BigInt(p.value) < BigInt(cur)
      what = `delay ${cur} -> ${p.value}`
    } else {
      weakening = true
      what = `paused impl -> ${p.target}`
    }
    if (!weakening) return pass([{ name: 'R7_CONFIG_GUARD', before: what, after: 'not weakening', ok: true }])
    const key = BigInt(p.codehash) !== 0n ? p.codehash : actionHash(kind, p.target, BigInt(p.value))
    const approved = await isApproved(key)
    const check = { name: 'R7_CONFIG_GUARD', before: what, after: approved ? 'approved' : 'not approved', ok: approved }
    return approved ? pass([check], { approvalKey: key }) : veto('R7_CONFIG_GUARD', [check], { approvalKey: key })
  }

  // kind 0: upgrade. Fetch what the simulation needs in parallel (main RPC, not the sim RPCs).
  const hasData = p.data && p.data !== '0x'
  const [newCode, slot, approved] = await Promise.all([
    getCode(p.target),
    main.call('eth_getStorageAt', [D.proxy, IMPLEMENTATION_SLOT, 'latest']),
    cfg.strict || hasData ? isApproved(p.codehash) : Promise.resolve(false),
  ])
  if (cfg.strict && !approved) {
    return veto('R5_STRICT_CODEHASH', [{ name: 'R5_STRICT_CODEHASH', before: p.codehash, after: 'not approved', ok: false }])
  }
  if (hasData && !approved) {
    return veto('R8_INIT_DATA', [{ name: 'R8_INIT_DATA', before: `${(p.data.length - 2) / 2} bytes init data`, after: 'codehash not approved', ok: false }])
  }
  if (!newCode || newCode === '0x' || keccak256(newCode) !== lc(p.codehash)) {
    return veto('R6_SIM_FAILURE', [{ name: 'R6_SIM_FAILURE', before: p.codehash, after: 'code missing or codehash mismatch', ok: false }])
  }
  const oldImpl = implFromSlot(slot)
  const oldSelectors = extractSelectors(await getCode(oldImpl))

  const holder = D.holders[0]
  let bal = state.holderBalance.get(holder)
  if (!bal) bal = BigInt(await ethCall(D.proxy, abis.token, 'balanceOf', [holder]))
  const amount = bal / 100n > 0n ? bal / 100n : 1n

  const { params, layout } = buildSimulation({
    proxy: D.proxy, newImpl: p.target, newCode, holder, amount, watch: [D.owner, ...D.holders],
    tokenAbi: abis.token, callGas: cfg.simCallGas, readGas: cfg.simReadGas, maxCalls: cfg.simMaxCalls,
  })
  const simT = Date.now()
  const { result, rpc, errors } = await simulate(params)
  if (!result) {
    return veto('R6_SIM_FAILURE', [{ name: 'R6_SIM_FAILURE', before: 'eth_simulateV1', after: `failed on ${errors.length} provider(s)`, ok: false }], { errors })
  }
  try {
    const r = evaluateSimulation(result, layout, { tokenAbi: abis.token, oldSelectors })
    return { ...r, simMs: Date.now() - t, extra: { ...r.extra, simRpc: rpc, simRequestMs: Date.now() - simT, retried: errors.length > 0 } }
  } catch (e) {
    if (e instanceof ViewRevert) {
      return veto('R6_SIM_FAILURE', [{ name: 'R6_SIM_FAILURE', before: 'view', after: e.message.slice(0, 160), ok: false }], { simRpc: rpc })
    }
    throw e
  }
}

// ---------------------------------------------------------------- pipeline per proposal
async function onProposedLog(lg, path) {
  if (lg.removed) {
    log.warn(`removed log for tx ${lg.transactionHash}`)
    return
  }
  let ev
  try {
    ev = decodeEventLog({ abi: abis.guardedAdmin, data: lg.data, topics: lg.topics })
  } catch (e) {
    return log.warn(`undecodable Proposed log: ${e.message}`)
  }
  if (ev.eventName !== 'Proposed') return
  const id = Number(ev.args.id)
  if (seen.has(id)) {
    state.duplicates++ // WS and polling both deliver: dedupe by proposal id
    return
  }
  const t0 = Date.now()
  const p = {
    id, kind: Number(ev.args.kind), target: lc(ev.args.target), value: ev.args.value, data: ev.args.data,
    codehash: lc(ev.args.codehash), readyBlock: Number(ev.args.readyBlock),
    proposeBlock: Number(lg.blockNumber), blockHash: lg.blockHash, txHash: lg.transactionHash,
  }
  seen.set(id, { t0, ...p })
  if (state.nextId == null || id + 1 > state.nextId) {
    state.nextId = id + 1
    vetoer.presign(state.nextId).catch(() => {})
  }
  emit('proposal_seen', { id, kind: p.kind, target: p.target, codehash: p.codehash, proposeBlock: p.proposeBlock, readyBlock: p.readyBlock, path })
  pendingFinality.push({ type: 'proposal', id, block: p.proposeBlock, txHash: p.txHash })
  if (state.lastBlock && p.readyBlock <= state.lastBlock) log.warn(`#${id} already past readyBlock ${p.readyBlock} (seen at ${state.lastBlock})`)

  emit('sim_started', { id })
  let j
  try {
    j = await judge(p)
  } catch (e) {
    log.error(`#${id} judge error (fail-closed R6): ${e.stack ?? e.message}`)
    j = { verdict: 'veto', rule: 'R6_SIM_FAILURE', checks: [{ name: 'R6_SIM_FAILURE', before: 'judge', after: e.message.slice(0, 160), ok: false }], selectorsAdded: [], simMs: Date.now() - t0, extra: {} }
  }
  const ruleHash = j.rule ? rules[j.rule].hash : null

  // Veto first (broadcast starts before anything else), then tell the screens.
  // sim_result is emitted synchronously before the (async) signing/broadcast continues, and
  // veto_sent fires the moment the raw tx goes out (before any RPC answers).
  const sending = j.verdict === 'veto'
    ? vetoer.send('veto', [BigInt(id), ruleHash], { onBroadcast: ({ txHash, rpcs }) => emit('veto_sent', { id, txHash, rpcs }) })
    : null
  emit('sim_result', { id, verdict: j.verdict, rule: j.rule, ruleHash, checks: j.checks, selectorsAdded: j.selectorsAdded, simMs: j.simMs, extra: j.extra })
  log.info(`#${id} kind=${p.kind} ${j.verdict}${j.rule ? ' ' + j.rule : ''} in ${j.simMs} ms`)
  if (!sending) return

  let tx
  try {
    tx = await sending
  } catch (e) {
    return log.error(`#${id} veto broadcast failed: ${e.message}`)
  }
  if (tx.dryRun) return log.info(`#${id} DRY_RUN: veto signed (${tx.txHash}) but not broadcast`)
  try {
    const r = await tx.receipt
    const block = Number(r.blockNumber)
    emit('veto_receipt', {
      id, txHash: tx.txHash, block, status: r.status === '0x1' ? 'success' : 'reverted', gasUsed: Number(r.gasUsed),
      gasLimit: Number(tx.gasLimit), effectiveGasPrice: BigInt(r.effectiveGasPrice ?? 0).toString(), latencyMs: Date.now() - t0,
      extra: { vetoBlocksAfterPropose: block - p.proposeBlock, blocksLeftForAttacker: p.readyBlock - block },
    })
    pendingFinality.push({ type: 'veto', id, block, txHash: tx.txHash })
  } catch (e) {
    log.error(`#${id} veto receipt: ${e.message}`)
  }
}

// ---------------------------------------------------------------- finality (spec 4.3 step 5)
async function finalizedBlock() {
  if (cfg.finality.startsWith('depth:')) return state.lastBlock - Number(cfg.finality.slice(6))
  const b = await main.call('eth_getBlockByNumber', ['finalized', false])
  return b ? Number(b.number) : 0
}
let finalityBusy = false
async function checkFinality() {
  if (finalityBusy || !pendingFinality.length) return
  finalityBusy = true
  try {
    const fin = await finalizedBlock()
    for (let k = pendingFinality.length - 1; k >= 0; k--) {
      const item = pendingFinality[k]
      if (fin < item.block) continue
      pendingFinality.splice(k, 1)
      if (item.type === 'veto') {
        const r = await main.call('eth_getTransactionReceipt', [item.txHash]).catch(() => null)
        if (r && Number(r.blockNumber) <= fin) emit('veto_finalized', { id: item.id, txHash: item.txHash, block: Number(r.blockNumber) })
        else {
          log.warn(`#${item.id} veto tx ${item.txHash} not found at finality; re-checking`)
          if (r) pendingFinality.push({ ...item, block: Number(r.blockNumber) })
        }
      } else {
        const logs = await main.call('eth_getLogs', [{
          address: D.guardedAdmin, fromBlock: numberToHex(item.block), toBlock: numberToHex(item.block),
          topics: [PROPOSED_TOPIC, pad(numberToHex(item.id), { size: 32 })],
        }]).catch(() => null)
        if (logs && logs.length === 0) {
          log.warn(`#${item.id} Proposed log gone before finality`)
          emit('proposal_dropped', { id: item.id })
        } else if (!logs) pendingFinality.push(item) // RPC error: retry later
      }
    }
  } catch (e) {
    log.warn(`finality check: ${e.message}`)
  } finally {
    finalityBusy = false
  }
}

// ---------------------------------------------------------------- detection path 1: getLogs polling
let cursor = null
async function pollOnce() {
  const latest = Number(await main.call('eth_blockNumber'))
  state.lastBlock = Math.max(state.lastBlock, latest)
  state.lastPollOk = Date.now()
  if (cursor == null) cursor = Math.max(D.deployBlock - 1, latest - cfg.lookbackBlocks)
  while (cursor < latest) {
    const from = cursor + 1
    const to = Math.min(latest, from + cfg.getLogsMaxRange - 1) // at most 100 blocks per request
    const logs = await main.call('eth_getLogs', [{ address: D.guardedAdmin, topics: [PROPOSED_TOPIC], fromBlock: numberToHex(from), toBlock: numberToHex(to) }])
    for (const lg of logs) onProposedLog(lg, 'poll').catch((e) => log.error(`poll handler: ${e.message}`))
    cursor = to // advance only after success; on error the cursor stays put
  }
}
async function pollLoop() {
  await sleep(cfg.pollOffsetMs)
  for (;;) {
    const t = Date.now()
    try {
      await pollOnce()
    } catch (e) {
      log.warn(`poll: ${e.message.slice(0, 200)}`)
    }
    checkFinality()
    await sleep(Math.max(0, cfg.pollMs - (Date.now() - t)))
  }
}

// ---------------------------------------------------------------- detection path 2: WebSocket
function startWs() {
  if (!cfg.wsUrl) return
  let backoff = 500
  let subLogs = null
  let subHeads = null
  const connect = () => {
    const ws = new WebSocket(cfg.wsUrl)
    ws.onopen = () => {
      state.wsConnected = true
      backoff = 500
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: [cfg.wsLogsKind, { address: D.guardedAdmin, topics: [PROPOSED_TOPIC] }] }))
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_subscribe', params: [cfg.wsHeadsKind] }))
      log.info(`ws connected (${cfg.wsLogsKind} + ${cfg.wsHeadsKind})`)
    }
    ws.onmessage = (m) => {
      let msg
      try {
        msg = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString())
      } catch {
        return
      }
      if (msg.id === 1) subLogs = msg.result
      else if (msg.id === 2) subHeads = msg.result
      if (msg.error) log.warn(`ws subscribe error: ${msg.error.message}`)
      if (msg.method !== 'eth_subscription') return
      const { subscription, result } = msg.params
      if (subscription === subLogs) onProposedLog(result, 'ws').catch((e) => log.error(`ws handler: ${e.message}`))
      else if (subscription === subHeads && result?.number) {
        state.lastBlock = Math.max(state.lastBlock, Number(result.number))
        state.lastWsHead = Date.now()
      }
    }
    ws.onclose = () => {
      state.wsConnected = false
      subLogs = subHeads = null
      setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, 5_000)
    }
    ws.onerror = () => {}
  }
  connect()
}

// ---------------------------------------------------------------- background refreshers
async function refreshViews() {
  try {
    const [d, n] = await Promise.all([
      ethCall(D.guardedAdmin, abis.guardedAdmin, 'delayBlocks'),
      ethCall(D.guardedAdmin, abis.guardedAdmin, 'nextId'),
    ])
    state.delayBlocks = BigInt(d)
    if (state.nextId == null || Number(n) > state.nextId) state.nextId = Number(n)
    await vetoer.presign(state.nextId)
    for (const h of D.holders.slice(0, 1)) state.holderBalance.set(h, BigInt(await ethCall(D.proxy, abis.token, 'balanceOf', [h])))
  } catch (e) {
    log.warn(`view refresh: ${e.message.slice(0, 160)}`)
  }
}

// ---------------------------------------------------------------- start
await server.listen()
// Warm every connection before the first proposal arrives (new TLS connections are slow).
await Promise.allSettled([main, ...sims, ...broadcastRpcs].map((r) => r.call('eth_chainId')))
await retry(() => vetoer.init(), { log, what: 'signer init' })
const isG = await ethCall(D.guardedAdmin, abis.guardedAdmin, 'isGuardian', [account.address]).catch(() => null)
if (isG === false) log.warn(`${account.address} is NOT a guardian of ${D.guardedAdmin}: vetoes will revert`)
await refreshViews()
setInterval(refreshViews, 5_000)
if (cfg.simKeepaliveMs > 0) setInterval(() => sims.forEach((s) => s.call('eth_chainId').catch(() => {})), cfg.simKeepaliveMs)
setInterval(() => emit('heartbeat', { lastBlock: state.lastBlock, rpc: main.label, ok: healthy() }), cfg.heartbeatMs)
startWs()
pollLoop()
log.info(`up: guardedAdmin=${D.guardedAdmin} proxy=${D.proxy} sse=:${cfg.ssePort} rpc=${main.label} sim=[${simOrder.map((s) => s.label).join(', ')}] ws=${cfg.wsUrl ? 'on' : 'off'} strict=${cfg.strict} attach=${cfg.attach}`)

const shutdown = async () => {
  vetoer.stop()
  await server.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
