// Arena Durable Object (one instance, idFromName('arena')). An alarm loop (TICK_MS while a proposal
// is in flight, IDLE_TICK_MS otherwise) reads the chain with a block cursor and runs:
//   - three cloud sentinels: every new Proposed is judged by each sentinel independently (same rules
//     as sentinel/), violations are vetoed with that sentinel's own key, sentinel 1 attaches the
//     template report hash;
//   - the cloud driver: POST /api/attack proposes an upgrade with the admin key; at readyBlock the
//     engine executes it once (a vetoed proposal is sent too, so the chain records the revert).
// All state (cursor, proposals, nonces, rate limits) lives in Durable Object storage.
import { DurableObject } from 'cloudflare:workers'
import { decodeErrorResult, decodeEventLog, encodeFunctionData, keccak256, stringToBytes, toEventSelector } from 'viem'
import CONFIG from './generated/config.mjs'
import { createRpc, createFailover } from './rpc.mjs'
import { accountFromKey, Signer, currentFee } from './signer.mjs'
import { makeChainView, judgeSafe } from './judge.mjs'
import { makeReport } from './report.mjs'

const CARDS = ['evilMint', 'evilOwner', 'evilFee', 'v2', 'v1']
const EVIL = new Set(['evilMint', 'evilOwner', 'evilFee'])
const KIND_NAMES = ['Upgrade', 'SetGuardian', 'SetDelay', 'SetPausedImpl']
const MAX_KEEP = 20
const lc = (a) => (a ? String(a).toLowerCase() : a)
const num = (v, d) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const csv = (s) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean)
// bigint -> decimal string, deep (for storage and JSON).
const plain = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)))
const fmtMon = (wei) => {
  const w = BigInt(wei ?? 0)
  const s = w.toString().padStart(19, '0')
  return `${s.slice(0, -18)}.${s.slice(-18, -12)}`
}
const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10)

const EVENT_TOPICS = ['Proposed(uint256,uint8,address,uint256,bytes,bytes32,uint64)', 'Vetoed(uint256,address,bytes32,uint256)', 'Executed(uint256,address)', 'ReasonAttached(uint256,address,bytes32)'].map(toEventSelector)

function gasLimitOf(gas, key) {
  const v = gas?.[key]
  const n = typeof v === 'number' ? v : v?.gasLimit ?? v?.limit
  return n ? BigInt(n) : null
}

function buildStatic(env) {
  const dep = CONFIG.deployment
  const D = {
    chainId: Number(dep.chainId),
    guardedAdmin: lc(dep.guardedAdmin),
    proxy: lc(dep.proxy),
    owner: lc(dep.owner),
    tokenOwner: lc(dep.tokenOwner),
    holders: (dep.holders ?? []).map((h) => lc(typeof h === 'string' ? h : h.address)),
    guardians: dep.guardians.map(lc),
    impls: Object.fromEntries(Object.entries(dep.impls).map(([k, v]) => [k, lc(v)])),
    deployBlock: Number(dep.deployBlock ?? 0),
    delayBlocks: Number(dep.delayBlocks ?? 30),
    decimals: Number(dep.token?.decimals ?? 8),
    symbol: dep.token?.symbol ?? 'dBTC',
  }
  const implLabel = Object.fromEntries(Object.entries(D.impls).map(([k, v]) => [v, k]))
  const abis = CONFIG.abi
  // Rule table: keccak256("GUARD/<ID>"), checked against shared/rules.json at startup.
  const rules = {}
  for (const r of CONFIG.rules.rules ?? []) {
    const id = String(r.rule ?? r.id).replace(/^GUARD\//, '')
    const h = keccak256(stringToBytes(`GUARD/${id}`))
    if (lc(r.ruleHash ?? r.hash) !== h) throw new Error(`rules.json hash mismatch for ${id}`)
    rules[id] = h
  }
  const headroom = num(env.GAS_HEADROOM, 1.25)
  const g = CONFIG.gas
  const ceil = (x) => BigInt(Math.ceil(Number(x) * headroom))
  const gas = {
    propose: gasLimitOf(g, 'propose') ?? 200_000n,
    execute: gasLimitOf(g, 'execute') ?? 150_000n,
    executeRevert: g?._detail?.execute_vetoed_revert ? ceil(g._detail.execute_vetoed_revert) : 60_000n,
    veto: ceil(gasLimitOf(g, 'veto') ?? 160_000n),
    attachReason: ceil(gasLimitOf(g, 'attachReason') ?? 96_000n),
  }
  const cfg = {
    readRpcs: csv(env.READ_RPCS),
    simRpcs: csv(env.SIM_RPCS),
    broadcastRpcs: csv(env.BROADCAST_RPCS),
    tickMs: num(env.TICK_MS, 1000),
    idleTickMs: num(env.IDLE_TICK_MS, 4000),
    lingerMs: num(env.ACTIVE_LINGER_SEC, 60) * 1000,
    getLogsMaxRange: num(env.GETLOGS_MAX_RANGE, 100),
    ipCooldownMs: num(env.IP_COOLDOWN_SEC, 45) * 1000,
    hourlyMax: num(env.HOURLY_MAX, 40),
    dailyMax: num(env.DAILY_MAX, 300),
    minPriorityWei: BigInt(Math.round(num(env.MIN_PRIORITY_GWEI, 10) * 1e9)),
    simTimeoutMs: num(env.SIM_TIMEOUT_MS, 2500),
    simBudgetMs: num(env.SIM_BUDGET_MS, 5000),
    simStaggerMs: num(env.SIM_STAGGER_MS, 150),
    simRotate: env.SIM_ROTATE === '1',
    sharedSim: env.SIM_MODE === 'shared',
    rpcTimeoutMs: num(env.RPC_TIMEOUT_MS, 4000),
    strict: env.STRICT === '1',
    simCallGas: 300_000n,
    simReadGas: 100_000n,
    simMaxCalls: 150,
    blockMs: num(env.BLOCK_MS, 350),
  }
  return { D, implLabel, abis, rules, gas, cfg }
}

export class Arena extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.ctx = ctx
    this.env = env
    this.boot = null
    this.bootError = null
    try {
      this.S = buildStatic(env)
    } catch (e) {
      this.bootError = `config: ${e.message}`
    }
    ctx.blockConcurrencyWhile(async () => {
      this.s = (await ctx.storage.get('state')) ?? null
      if (!this.s || this.s.v !== 1 || this.s.guardedAdmin !== this.S?.D.guardedAdmin) this.s = this.freshState()
      // A judgment interrupted by an eviction is picked up again by the next tick.
      for (const r of Object.values(this.s.proposals)) if (r.judging && !r.judged) r.judging = false
    })
  }

  freshState() {
    return {
      v: 1,
      guardedAdmin: this.S?.D.guardedAdmin ?? null,
      cursor: null,
      lastBlock: null,
      proposals: {},
      nonces: {},
      rate: { ip: {}, hour: [], day: { key: utcDay(), n: 0 } },
      active: null,
      engine: { ticks: 0, startedAt: Date.now(), lastTickAt: null, lastTickMs: null, lastOkAt: null, lastError: null, lastErrorAt: null, lastActivityAt: 0, skipped: 0 },
      balances: null,
      impl: null,
      fee: null,
    }
  }

  async save() {
    await this.ctx.storage.put('state', this.s)
  }

  // ------------------------------------------------------------------ wiring (lazy, per isolate)
  wire() {
    if (this.boot) return this.boot
    if (this.bootError) throw new Error(this.bootError)
    const { cfg, D } = this.S
    const read = createFailover(cfg.readRpcs.map((u) => createRpc(u, { timeoutMs: cfg.rpcTimeoutMs })))
    const sims = cfg.simRpcs.map((u) => createRpc(u, { timeoutMs: cfg.simTimeoutMs }))
    const broadcast = cfg.broadcastRpcs.map((u) => createRpc(u, { timeoutMs: 5_000 }))
    const nonces = {
      get: async (a) => this.s.nonces[lc(a)] ?? null,
      set: async (a, n) => {
        this.s.nonces[lc(a)] = n
        await this.save()
      },
    }
    const problems = []
    const mk = (secret, label) => {
      try {
        return new Signer({ account: accountFromKey(this.env[secret], secret), label, chainId: D.chainId, read, broadcast, nonces })
      } catch (e) {
        problems.push(e.message)
        return null
      }
    }
    const admin = mk('ADMIN_KEY', 'admin')
    const sentinels = [1, 2, 3].map((i) => mk(`SENTINEL${i}_KEY`, `sentinel-${i}`))
    if (admin && lc(admin.address) !== D.owner) problems.push(`ADMIN_KEY address is not the GuardedAdmin owner from the deployment`)
    sentinels.forEach((s, k) => {
      if (s && !D.guardians.includes(lc(s.address))) problems.push(`SENTINEL${k + 1}_KEY address is not a guardian in the deployment`)
    })
    this.boot = { read, sims, broadcast, admin, sentinels, problems, chainChecked: false }
    return this.boot
  }

  async fee() {
    const b = this.wire()
    if (!this.feeCache || Date.now() - this.feeCache.at > 10_000) this.feeCache = await currentFee(b.read, this.S.cfg.minPriorityWei)
    return this.feeCache
  }

  noteError(where, e) {
    this.s.engine.lastError = `${where}: ${String(e?.message ?? e).slice(0, 300)}`
    this.s.engine.lastErrorAt = Date.now()
  }

  // ------------------------------------------------------------------ alarm loop
  async ensureAlarm() {
    const at = await this.ctx.storage.getAlarm()
    if (at == null || at < Date.now() - 30_000) await this.ctx.storage.setAlarm(Date.now() + 100)
    return { armed: true }
  }

  isBusy() {
    return !!this.s.active || Date.now() - (this.s.engine.lastActivityAt ?? 0) < (this.S?.cfg.lingerMs ?? 60_000)
  }

  async alarm() {
    const t0 = Date.now()
    try {
      await this.tick()
      this.s.engine.lastOkAt = Date.now()
    } catch (e) {
      this.noteError('tick', e)
    } finally {
      this.s.engine.ticks++
      this.s.engine.lastTickAt = Date.now()
      this.s.engine.lastTickMs = Date.now() - t0
      await this.save()
      const period = this.isBusy() ? this.S?.cfg.tickMs ?? 1000 : this.S?.cfg.idleTickMs ?? 4000
      const next = Date.now() + Math.max(200, period - (Date.now() - t0))
      // POST /api/attack may have asked for an earlier tick while this one ran: keep the earlier one.
      const cur = await this.ctx.storage.getAlarm()
      if (cur == null || cur > next) await this.ctx.storage.setAlarm(next)
    }
  }

  async tick() {
    const b = this.wire()
    const { D, cfg } = this.S
    if (!b.chainChecked) {
      const id = Number(await b.read.call('eth_chainId'))
      if (id !== D.chainId) throw new Error(`RPC chainId ${id} != deployment chainId ${D.chainId}`)
      b.chainChecked = true
    }
    const latest = Number(await b.read.call('eth_blockNumber'))
    this.s.lastBlock = latest
    if (this.s.cursor == null) this.s.cursor = Math.max(D.deployBlock - 1, latest - 2 * cfg.getLogsMaxRange)
    if (latest - this.s.cursor > 10 * cfg.getLogsMaxRange) {
      // Long downtime: anything older than this is far past its readyBlock.
      this.s.engine.skipped += latest - 2 * cfg.getLogsMaxRange - this.s.cursor
      this.s.cursor = latest - 2 * cfg.getLogsMaxRange
    }
    for (let k = 0; k < 4 && this.s.cursor < latest; k++) {
      const from = this.s.cursor + 1
      const to = Math.min(latest, from + cfg.getLogsMaxRange - 1)
      const logs = await b.read.call('eth_getLogs', [{ address: D.guardedAdmin, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics: [EVENT_TOPICS] }])
      for (const lg of logs ?? []) this.applyLog(lg)
      this.s.cursor = to
    }
    const fresh = Object.values(this.s.proposals).filter((r) => r.kind != null && !r.judged && !r.judging && latest < r.readyBlock + 5)
    if (fresh.length) {
      this.s.engine.lastActivityAt = Date.now()
      await this.save()
      await Promise.all(fresh.map((rec) => this.handleProposal(rec).catch((e) => this.noteError(`proposal #${rec.id}`, e))))
    }
    await this.executeStep(latest).catch((e) => this.noteError('execute', e))
    await this.receiptStep().catch((e) => this.noteError('receipts', e))
    this.releaseActive(latest)
    if (!this.s.balances || Date.now() - this.s.balances.at > (this.isBusy() ? 10_000 : 30_000)) await this.refreshBalances().catch((e) => this.noteError('balances', e))
  }

  // ------------------------------------------------------------------ chain events
  record(id) {
    const k = String(id)
    if (!this.s.proposals[k]) {
      this.s.proposals[k] = {
        id: Number(id), kind: null, kindName: null, card: null, proposer: 'arena', proposerAddress: null, target: null, codehash: null, data: null,
        proposeTx: null, proposeBlock: null, readyBlock: null, proposedAt: null, seenAt: null, seenBlock: null,
        status: 'pending', judged: false, sentinels: [], chainVetoes: [], vetoCount: 0, firstVetoBlock: null,
        vetoBlocksAfterPropose: null, blocksLeftForAttacker: null, report: null, execute: null, executed: null, costs: {},
      }
      const ids = Object.keys(this.s.proposals).map(Number).sort((a, b) => b - a)
      for (const old of ids.slice(MAX_KEEP)) delete this.s.proposals[String(old)]
    }
    return this.s.proposals[k]
  }

  applyLog(lg) {
    if (lg.removed) return null
    let ev
    try {
      ev = decodeEventLog({ abi: this.S.abis.guardedAdmin, data: lg.data, topics: lg.topics })
    } catch {
      return null
    }
    const block = Number(lg.blockNumber)
    const id = Number(ev.args.id)
    if (ev.eventName === 'Proposed') {
      const rec = this.record(id)
      const isNew = rec.kind == null
      Object.assign(rec, {
        kind: Number(ev.args.kind), kindName: KIND_NAMES[Number(ev.args.kind)] ?? 'Unknown', target: lc(ev.args.target), value: ev.args.value.toString(),
        data: ev.args.data, codehash: lc(ev.args.codehash), readyBlock: Number(ev.args.readyBlock), proposeBlock: block, proposeTx: lg.transactionHash,
        proposerAddress: this.S.D.owner,
      })
      rec.card ??= Number(ev.args.kind) === 0 ? this.S.implLabel[rec.target] ?? 'unknown' : KIND_NAMES[rec.kind]
      if (isNew || !rec.seenAt) {
        rec.seenAt = Date.now()
        rec.seenBlock = this.s.lastBlock
      }
      if (this.s.active && this.s.active.id == null && lc(this.s.active.txHash) === lc(lg.transactionHash)) {
        this.s.active.id = id
        rec.card = this.s.active.card
        rec.proposedAt ??= this.s.active.startedAt
      }
      return null
    }
    const rec = this.s.proposals[String(id)]
    if (!rec) return null
    if (ev.eventName === 'Vetoed') {
      const g = lc(ev.args.guardian)
      if (!rec.chainVetoes.some((v) => v.txHash === lg.transactionHash)) {
        rec.chainVetoes.push({ guardian: g, sentinel: this.S.D.guardians.indexOf(g) + 1 || null, ruleHash: ev.args.ruleHash, vetoCount: Number(ev.args.vetoCount), block, txHash: lg.transactionHash })
      }
      rec.vetoCount = Math.max(rec.vetoCount, Number(ev.args.vetoCount))
      rec.status = rec.executed ? rec.status : 'vetoed'
      if (rec.firstVetoBlock == null || block < rec.firstVetoBlock) {
        rec.firstVetoBlock = block
        if (rec.proposeBlock != null) rec.vetoBlocksAfterPropose = block - rec.proposeBlock
        if (rec.readyBlock != null) rec.blocksLeftForAttacker = rec.readyBlock - block
      }
      const s = rec.sentinels.find((x) => lc(x.address) === g)
      if (s) Object.assign(s, { vetoBlock: block, vetoTx: s.vetoTx ?? lg.transactionHash, vetoConfirmed: true })
    } else if (ev.eventName === 'Executed') {
      rec.status = 'executed'
      rec.executed = { block, txHash: lg.transactionHash, executor: lc(ev.args.executor) }
      this.s.impl = null // re-read on the next balance refresh
      this.s.balances = null
    } else if (ev.eventName === 'ReasonAttached') {
      rec.report ??= {}
      Object.assign(rec.report, { onchainHash: ev.args.reportHash, attachBlock: block, attachTx: rec.report.attachTx ?? lg.transactionHash, attachConfirmed: true })
    }
    return null
  }

  // ------------------------------------------------------------------ cloud sentinels
  async handleProposal(rec) {
    if (rec.judged || rec.judging) return
    rec.judging = true
    const b = this.wire()
    const { D, abis, cfg, rules, gas } = this.S
    const view = makeChainView({ read: b.read, D, abis })
    const p = { id: rec.id, kind: rec.kind, target: rec.target, value: BigInt(rec.value ?? 0), data: rec.data, codehash: rec.codehash }
    // SIM_MODE=independent (default): each sentinel runs its own simulation (own random stranger).
    // SIM_MODE=shared: one simulation, three independent signatures (a third of the CPU and RPC use).
    const judgeFor = (k) => {
      const sims = cfg.simRotate ? b.sims.map((_, j) => b.sims[(k + j) % b.sims.length]) : b.sims
      return judgeSafe(p, { view, sims, D, abis, cfg }, k * cfg.simStaggerMs)
    }
    const results = cfg.sharedSim ? Array(3).fill(await judgeFor(0)) : await Promise.all([0, 1, 2].map(judgeFor))
    rec.sentinels = results.map((j, k) => ({
      index: k + 1,
      address: b.sentinels[k]?.address ?? D.guardians[k],
      verdict: j.verdict,
      rule: j.rule,
      ruleHash: j.rule ? rules[j.rule] : null,
      simMs: j.simMs,
      simRpc: j.extra?.simRpc ?? null,
      checks: plain(j.checks),
      selectorsAdded: j.selectorsAdded,
      extra: plain({ culprits: j.extra?.culprits, skimmedTo: j.extra?.skimmedTo, thirdPartyDeltas: j.extra?.thirdPartyDeltas, newOpcodes: j.extra?.newOpcodes, selectorsRemoved: j.extra?.selectorsRemoved, errors: j.extra?.errors, retried: j.extra?.retried }),
      judgedAt: Date.now(),
    }))
    rec.judged = true
    rec.judging = false
    rec.verdict = results.some((j) => j.verdict === 'veto') ? 'veto' : 'pass'
    await this.save()

    // Vetoes first, from every sentinel that found a violation, in parallel (separate keys).
    const vetoing = rec.sentinels.filter((s) => s.verdict === 'veto')
    if (vetoing.length) {
      const fee = await this.fee()
      await Promise.all(
        vetoing.map(async (s) => {
          const signer = b.sentinels[s.index - 1]
          if (!signer) return (s.vetoError = 'no key')
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const tx = await signer.send({ to: D.guardedAdmin, abi: abis.guardedAdmin, functionName: 'veto', args: [BigInt(rec.id), s.ruleHash], gas: gas.veto, fee })
              Object.assign(s, { vetoTx: tx.txHash, vetoSentAt: Date.now(), vetoGasLimit: tx.gasLimit, vetoAcceptedBy: tx.acceptedBy, vetoLatencyMs: Date.now() - rec.seenAt, vetoError: null })
              return
            } catch (e) {
              s.vetoError = String(e.message).slice(0, 200)
              if ((this.s.lastBlock ?? 0) >= rec.readyBlock) return
              await sleep(250 * attempt)
            }
          }
        }),
      )
      await this.save()
    }

    // Report: Workers AI wording (template fallback) from the first vetoing sentinel's result (or sentinel 1's pass).
    const src = vetoing[0] ?? rec.sentinels[0]
    try {
      const sim = { id: rec.id, verdict: src.verdict, rule: src.rule, ruleHash: src.ruleHash, checks: src.checks, selectorsAdded: src.selectorsAdded, simMs: src.simMs, extra: src.extra, mode: 'testnet' }
      const prop = { id: rec.id, kind: rec.kind, target: rec.target, codehash: rec.codehash, proposeBlock: rec.proposeBlock, readyBlock: rec.readyBlock }
      const r = await makeReport(sim, prop, { decimals: D.decimals, symbol: D.symbol, ai: this.env.AI })
      rec.report = { ...(rec.report ?? {}), text: r.text, hash: r.hash, template: r.template, model: r.model, fallbackReason: r.fallbackReason, genMs: r.ms, rule: r.rule, bySentinel: src.index }
    } catch (e) {
      this.noteError(`report #${rec.id}`, e)
    }
    // attachReason on chain only for a veto, from the first vetoing sentinel (sentinel 1 normally).
    if (vetoing.length && rec.report?.hash && b.sentinels[src.index - 1]) {
      try {
        const fee = await this.fee()
        const tx = await b.sentinels[src.index - 1].send({ to: D.guardedAdmin, abi: abis.guardedAdmin, functionName: 'attachReason', args: [BigInt(rec.id), rec.report.hash], gas: gas.attachReason, fee })
        Object.assign(rec.report, { attachTx: tx.txHash, attachGasLimit: tx.gasLimit, attachSentAt: Date.now() })
      } catch (e) {
        rec.report.attachError = String(e.message).slice(0, 200)
      }
    }
    await this.save()
  }

  // ------------------------------------------------------------------ cloud driver: execute at readyBlock
  async executeStep(latest) {
    const b = this.wire()
    const { D, abis, gas } = this.S
    for (const rec of Object.values(this.s.proposals)) {
      if (rec.execute || rec.kind == null || rec.readyBlock == null || latest < rec.readyBlock || !rec.judged) continue
      if (rec.status === 'executed') continue
      if (latest > rec.readyBlock + 600) continue // ancient (engine was down): leave it alone
      // A veto that is still on its way: give it a few blocks so the call reflects it.
      const vetoPending = rec.verdict === 'veto' && !rec.chainVetoes.length
      if (vetoPending && latest < rec.readyBlock + 15) continue
      if (!b.admin) {
        rec.execute = { result: 'skipped', error: 'ADMIN_KEY not set', at: Date.now() }
        continue
      }
      const data = encodeFunctionData({ abi: abis.guardedAdmin, functionName: 'execute', args: [BigInt(rec.id)] })
      let callError = null
      try {
        await b.read.call('eth_call', [{ from: b.admin.address, to: D.guardedAdmin, data }, 'latest'])
      } catch (e) {
        const raw = typeof e.data === 'string' ? e.data : e.data?.data
        try {
          callError = raw && raw !== '0x' ? decodeErrorResult({ abi: abis.guardedAdmin, data: raw }).errorName : String(e.message).slice(0, 120)
        } catch {
          callError = String(e.message).slice(0, 120)
        }
      }
      if (callError === 'TooEarly') continue // the read node is a block behind
      if (!callError && EVIL.has(rec.card)) {
        // No veto reached the chain in time: the engine does not complete a malicious upgrade itself.
        rec.execute = { result: 'held', callError: null, note: 'veto not on chain; engine did not execute an attack card', at: Date.now() }
        continue
      }
      try {
        const fee = await this.fee()
        const g = callError ? gas.executeRevert : gas.execute
        rec.execute = { result: 'sent', expected: callError ? 'reverted' : 'success', callError, at: Date.now() }
        await this.save()
        const tx = await b.admin.send({ to: D.guardedAdmin, abi: abis.guardedAdmin, functionName: 'execute', args: [BigInt(rec.id)], gas: g, fee })
        Object.assign(rec.execute, { txHash: tx.txHash, gasLimit: tx.gasLimit })
      } catch (e) {
        rec.execute = { result: 'failed', callError, error: String(e.message).slice(0, 200), at: Date.now() }
      }
      await this.save()
    }
  }

  // ------------------------------------------------------------------ receipts and costs
  async receiptStep() {
    const b = this.wire()
    const want = []
    for (const rec of Object.values(this.s.proposals)) {
      const g = this.S.gas
      if (rec.proposeTx && !rec.costs.propose) want.push([rec, 'propose', rec.proposeTx, g.propose, (r) => r])
      for (const s of rec.sentinels) if (s.vetoTx && !s.vetoReceipt) want.push([rec, `veto${s.index}`, s.vetoTx, s.vetoGasLimit, (r) => (s.vetoReceipt = r)])
      if (rec.report?.attachTx && !rec.costs.attachReason) want.push([rec, 'attachReason', rec.report.attachTx, rec.report.attachGasLimit, (r) => r])
      if (rec.execute?.txHash && !rec.execute.status) {
        want.push([rec, 'execute', rec.execute.txHash, rec.execute.gasLimit, (r) => Object.assign(rec.execute, { status: r.status, block: r.block, result: r.status === 'success' ? 'success' : 'reverted', error: r.status === 'success' ? null : rec.execute.callError ?? 'reverted' })])
      }
    }
    for (const [rec, key, hash, knownGasLimit, apply] of want.slice(0, 8)) {
      if (Date.now() - (rec.seenAt ?? Date.now()) > 15 * 60_000) continue
      const r = await b.read.call('eth_getTransactionReceipt', [hash]).catch(() => null)
      if (!r) continue
      const gasUsed = BigInt(r.gasUsed)
      const price = BigInt(r.effectiveGasPrice ?? 0)
      const gasLimit = knownGasLimit != null ? BigInt(knownGasLimit) : gasUsed
      // Monad charges gas limit x price; costWei uses that, gasUsed is kept for reference.
      const out = { txHash: hash, block: Number(r.blockNumber), status: r.status === '0x1' ? 'success' : 'reverted', gasUsed: gasUsed.toString(), gasLimit: gasLimit.toString(), effectiveGasPrice: price.toString(), costWei: (gasLimit * price).toString() }
      apply(out)
      rec.costs[key] = out
      if (key.startsWith('veto') && out.status === 'success') {
        const s = rec.sentinels.find((x) => `veto${x.index}` === key)
        if (s) s.vetoBlock ??= out.block
        if (rec.firstVetoBlock == null || out.block < rec.firstVetoBlock) {
          rec.firstVetoBlock = out.block
          rec.vetoBlocksAfterPropose = rec.proposeBlock != null ? out.block - rec.proposeBlock : null
          rec.blocksLeftForAttacker = rec.readyBlock != null ? rec.readyBlock - out.block : null
        }
      }
      if (key === 'attachReason' && rec.report) rec.report.attachBlock ??= out.block
    }
  }

  releaseActive(latest) {
    const a = this.s.active
    if (!a) return
    const rec = a.id != null ? this.s.proposals[String(a.id)] : null
    const done = rec && (rec.execute?.status || ['held', 'failed', 'skipped'].includes(rec.execute?.result))
    const stale = Date.now() - a.startedAt > 120_000 || (rec?.readyBlock != null && latest > rec.readyBlock + 120)
    if (done || stale) {
      this.s.active = null
      this.s.engine.lastActivityAt = Date.now()
    }
  }

  async refreshBalances() {
    const b = this.wire()
    const { D, abis } = this.S
    const addrs = [b.admin?.address ?? D.owner, ...D.guardians.slice(0, 3)]
    const bals = await Promise.all(addrs.map((a) => b.read.call('eth_getBalance', [a, 'latest']).then((x) => BigInt(x).toString())))
    this.s.balances = {
      at: Date.now(),
      admin: { address: addrs[0], wei: bals[0], mon: fmtMon(bals[0]) },
      sentinels: addrs.slice(1).map((a, k) => ({ index: k + 1, address: a, wei: bals[k + 1], mon: fmtMon(bals[k + 1]) })),
    }
    const view = makeChainView({ read: b.read, D, abis })
    const impl = await view.currentImpl()
    this.s.impl = { address: impl, label: this.S.implLabel[impl] ?? 'unknown', at: Date.now() }
    // Idle nonce check: a transaction that never got mined would hold every later nonce of that key;
    // when nothing is in flight, a stored nonce ahead of the chain is reset to the chain's count.
    if (!this.isBusy()) {
      for (const signer of [b.admin, ...b.sentinels].filter(Boolean)) {
        const stored = this.s.nonces[lc(signer.address)]
        if (stored == null) continue
        const chain = Number(await b.read.call('eth_getTransactionCount', [signer.address, 'latest']))
        if (chain !== stored) {
          this.s.nonces[lc(signer.address)] = chain
          this.noteError('nonce', new Error(`${signer.label} nonce ${stored} -> ${chain} (resynced while idle)`))
        }
      }
    }
  }

  // ------------------------------------------------------------------ HTTP
  async fetch(request) {
    const url = new URL(request.url)
    try {
      if (url.pathname === '/api/health' && request.method === 'GET') return json(this.health())
      if (url.pathname === '/api/state' && request.method === 'GET') {
        await this.ensureAlarm()
        return json(this.state(clientIp(request)))
      }
      if (url.pathname === '/api/attack' && request.method === 'POST') {
        await this.ensureAlarm()
        return await this.attack(request)
      }
      return json({ ok: false, error: 'not found' }, 404)
    } catch (e) {
      this.noteError('http', e)
      return json({ ok: false, error: String(e.message).slice(0, 200) }, 500)
    }
  }

  health() {
    const e = this.s.engine
    const tickPeriod = this.isBusy() ? this.S?.cfg.tickMs : this.S?.cfg.idleTickMs
    const ok = !this.bootError && e.lastOkAt != null && Date.now() - e.lastOkAt < Math.max(15_000, 4 * (tickPeriod ?? 4000))
    let problems = []
    try {
      problems = this.wire().problems
    } catch (err) {
      problems = [err.message]
    }
    return {
      ok: ok && problems.length === 0,
      build: 'ai-report-3',
      lastBlock: this.s.lastBlock,
      cursor: this.s.cursor,
      lastTickAt: e.lastTickAt,
      lastOkAt: e.lastOkAt,
      lastTickMs: e.lastTickMs,
      lastError: e.lastError,
      lastErrorAt: e.lastErrorAt,
      busy: this.isBusy(),
      active: this.s.active ? { id: this.s.active.id ?? null, card: this.s.active.card } : null,
      problems,
    }
  }

  limits(ip) {
    const { cfg } = this.S
    const now = Date.now()
    const r = this.s.rate
    if (r.day.key !== utcDay()) r.day = { key: utcDay(), n: 0 }
    r.hour = r.hour.filter((t) => now - t < 3_600_000)
    for (const [k, t] of Object.entries(r.ip)) if (now - t >= cfg.ipCooldownMs) delete r.ip[k]
    const ipKey = ip ? keccak256(stringToBytes(`arena-ip:${ip}`)).slice(0, 18) : null
    const ipLeft = ipKey && r.ip[ipKey] ? Math.ceil((cfg.ipCooldownMs - (now - r.ip[ipKey])) / 1000) : 0
    const hourLeft = r.hour.length >= cfg.hourlyMax ? Math.ceil((3_600_000 - (now - r.hour[0])) / 1000) : 0
    const dayLeft = r.day.n >= cfg.dailyMax ? Math.ceil((Date.parse(`${r.day.key}T00:00:00Z`) + 86_400_000 - now) / 1000) : 0
    let busyLeft = 0
    if (this.s.active) {
      const rec = this.s.active.id != null ? this.s.proposals[String(this.s.active.id)] : null
      const blocks = rec?.readyBlock != null && this.s.lastBlock != null ? Math.max(0, rec.readyBlock - this.s.lastBlock) : this.S.D.delayBlocks
      busyLeft = Math.max(1, Math.ceil((blocks * cfg.blockMs) / 1000) + 3)
    }
    return {
      ipKey,
      ipCooldownSec: cfg.ipCooldownMs / 1000,
      hourlyMax: cfg.hourlyMax,
      dailyMax: cfg.dailyMax,
      hourUsed: r.hour.length,
      dayUsed: r.day.n,
      busy: !!this.s.active,
      busyRetryAfterSec: busyLeft,
      ipRetryAfterSec: ipLeft,
      hourRetryAfterSec: hourLeft,
      dayRetryAfterSec: dayLeft,
    }
  }

  cards() {
    const cur = this.s.impl?.label ?? null
    return CARDS.map((card) => ({
      card,
      impl: this.S.D.impls[card],
      kind: EVIL.has(card) ? 'attack' : 'upgrade',
      allowed: card === 'v1' ? cur === 'v2' : true,
      ...(card === 'v1' && cur !== 'v2' ? { reason: 'v1 is offered only while v2 is live' } : {}),
    }))
  }

  state(ip) {
    const { D } = this.S
    const L = this.limits(ip)
    delete L.ipKey
    const proposals = Object.values(this.s.proposals).sort((a, b) => b.id - a.id).slice(0, 10).map((r) => {
      const costs = Object.values(r.costs ?? {})
      const total = costs.reduce((x, c) => x + BigInt(c.costWei ?? 0), 0n)
      const vetoTotal = costs.filter((c) => r.sentinels.some((s) => s.vetoTx === c.txHash)).reduce((x, c) => x + BigInt(c.costWei ?? 0), 0n)
      const { judging, ...rest } = r
      return { ...rest, cost: { totalWei: total.toString(), totalMon: fmtMon(total), vetoWei: vetoTotal.toString(), vetoMon: fmtMon(vetoTotal), items: r.costs } }
    })
    return {
      ok: true,
      now: Date.now(),
      network: CONFIG.deployment.network ?? null,
      chainId: D.chainId,
      contracts: { guardedAdmin: D.guardedAdmin, proxy: D.proxy, proxyAdmin: lc(CONFIG.deployment.proxyAdmin), impls: D.impls, owner: D.owner, guardians: D.guardians },
      delayBlocks: D.delayBlocks,
      lastBlock: this.s.lastBlock,
      impl: this.s.impl,
      cards: this.cards(),
      balances: this.s.balances,
      limits: L,
      active: this.s.active ? { id: this.s.active.id ?? null, card: this.s.active.card, txHash: this.s.active.txHash ?? null, startedAt: this.s.active.startedAt } : null,
      engine: { ...this.health(), ticks: this.s.engine.ticks, startedAt: this.s.engine.startedAt, skippedBlocks: this.s.engine.skipped },
      proposals,
    }
  }

  async attack(request) {
    const { D, abis, gas } = this.S
    // JSON only: a cross-site form or no-cors fetch cannot send this content type without a preflight.
    if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) return json({ ok: false, error: 'content-type must be application/json' }, 415)
    let body = {}
    try {
      body = await request.json()
    } catch {}
    const card = String(body?.card ?? '')
    if (!CARDS.includes(card)) return json({ ok: false, error: 'unknown card', cards: CARDS.slice(0, 4) }, 400)
    const b = this.wire()
    if (!b.admin) return json({ ok: false, error: 'engine not configured (ADMIN_KEY)' }, 503)
    if (card === 'v1') {
      if (!this.s.impl || Date.now() - this.s.impl.at > 5_000) await this.refreshBalances().catch(() => {})
      if (this.s.impl?.label !== 'v2') return json({ ok: false, error: 'v1 is offered only while v2 is live' }, 409)
    }
    const ip = clientIp(request)
    const L = this.limits(ip)
    const deny = (reason, retryAfterSec) =>
      json({ ok: false, error: reason, retryAfterSec, limits: { hourUsed: L.hourUsed, hourlyMax: L.hourlyMax, dayUsed: L.dayUsed, dailyMax: L.dailyMax } }, 429, { 'retry-after': String(retryAfterSec) })
    if (L.busy) return deny('a proposal is already in flight', L.busyRetryAfterSec)
    if (L.ipRetryAfterSec > 0) return deny('one attack per 45 seconds per visitor', L.ipRetryAfterSec)
    if (L.hourRetryAfterSec > 0) return deny('hourly limit reached', L.hourRetryAfterSec)
    if (L.dayRetryAfterSec > 0) return deny('daily limit reached', L.dayRetryAfterSec)

    // Reserve the single in-flight slot before any await that could let another request in.
    const now = Date.now()
    this.s.active = { card, startedAt: now, id: null, txHash: null }
    if (L.ipKey) this.s.rate.ip[L.ipKey] = now
    this.s.rate.hour.push(now)
    this.s.rate.day.n++
    this.s.engine.lastActivityAt = now
    await this.save()
    const refund = async () => {
      this.s.active = null
      if (L.ipKey) delete this.s.rate.ip[L.ipKey]
      this.s.rate.hour = this.s.rate.hour.filter((t) => t !== now)
      this.s.rate.day.n = Math.max(0, this.s.rate.day.n - 1)
      await this.save()
    }

    let tx
    try {
      const fee = await this.fee()
      tx = await b.admin.send({ to: D.guardedAdmin, abi: abis.guardedAdmin, functionName: 'proposeUpgrade', args: [D.impls[card], '0x'], gas: gas.propose, fee })
    } catch (e) {
      await refund()
      this.noteError('propose', e)
      return json({ ok: false, error: `propose failed: ${String(e.message).slice(0, 160)}` }, 502)
    }
    this.s.active.txHash = tx.txHash
    await this.save()
    await this.ctx.storage.setAlarm(Date.now() + 50)

    // Wait (briefly) for the receipt to return id / proposeBlock / readyBlock.
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      const r = await b.read.call('eth_getTransactionReceipt', [tx.txHash]).catch(() => null)
      if (r) {
        if (r.status !== '0x1') {
          this.s.active = null
          await this.save()
          return json({ ok: false, error: 'propose reverted', txHash: tx.txHash }, 502)
        }
        for (const lg of r.logs ?? []) {
          if (lc(lg.address) !== D.guardedAdmin) continue
          try {
            const ev = decodeEventLog({ abi: abis.guardedAdmin, data: lg.data, topics: lg.topics })
            if (ev.eventName !== 'Proposed') continue
            const id = Number(ev.args.id)
            const rec = this.record(id)
            rec.card = card
            rec.proposedAt ??= now
            if (rec.proposeTx == null) {
              Object.assign(rec, { proposeTx: tx.txHash, proposeBlock: Number(r.blockNumber), readyBlock: Number(ev.args.readyBlock) })
            }
            this.s.active.id = id
            await this.save()
            return json({ ok: true, id, card, txHash: tx.txHash, proposeBlock: Number(r.blockNumber), readyBlock: Number(ev.args.readyBlock), delayBlocks: Number(ev.args.readyBlock) - Number(r.blockNumber) })
          } catch {}
        }
        break
      }
      await sleep(400)
    }
    return json({ ok: true, pending: true, card, txHash: tx.txHash, id: null, proposeBlock: null, readyBlock: null }, 202)
  }
}

function clientIp(request) {
  const fwd = (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim()
  return request.headers.get('cf-connecting-ip') ?? request.headers.get('x-real-ip') ?? (fwd || 'unknown')
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(plain(body)), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } })
}
