#!/usr/bin/env node
// Fake SSE event generator (spec 4.4) so the war-room frontend can be built without a chain.
// Serves three fake sentinels on 8701-8703 (/events, /health), and optionally a fake driver
// (8700) and fake reporter (8710). All hashes and addresses are random; numbers are labelled
// with the configured mode. Nothing here touches any RPC.
//
//   node fake-events.mjs                         # auto-loop the scripted cards every ~16 s
//   FAKE_AUTO=0 node fake-events.mjs             # only run cards on demand:
//     curl -XPOST localhost:8701/fake/propose -d '{"card":"evilMint"}'
//     curl -XPOST localhost:8701/fake/offline -d '{"sentinel":2,"seconds":5}'
//   FAKE_DRIVER=1 FAKE_REPORTER=1 node fake-events.mjs   # also serve 8700 and 8710
//   FAKE_MODE=testnet node fake-events.mjs       # mode field "testnet" instead of "replay"
//
// Cards: evilMint (R1), evilOwner (R2), evilFee (R3), v2 (pass), removeGuardian (R7)
import { keccak256, stringToBytes, toFunctionSelector, toHex } from 'viem'
import { createEventServer } from './src/sse.mjs'
import { computeRuleHash } from './src/rules.mjs'
import { sleep } from './src/util.mjs'

const MODE = process.env.FAKE_MODE ?? 'replay'
const BLOCK_MS = Number(process.env.FAKE_BLOCK_MS ?? 330)
const DELAY = Number(process.env.FAKE_DELAY_BLOCKS ?? 30)
const AUTO = process.env.FAKE_AUTO !== '0'
const BASE_PORT = Number(process.env.FAKE_BASE_PORT ?? 8701)
const DRIVER_PORT = Number(process.env.FAKE_DRIVER_PORT ?? 8700)
const REPORTER_PORT = Number(process.env.FAKE_REPORTER_PORT ?? 8710)
const WITH_DRIVER = process.env.FAKE_DRIVER === '1'
const WITH_REPORTER = process.env.FAKE_REPORTER === '1'
const CARDS = (process.env.FAKE_CARDS ?? 'evilMint,v2,evilFee,evilOwner,removeGuardian').split(',')

const rnd = (n) => toHex(crypto.getRandomValues(new Uint8Array(n)))
const addr = () => rnd(20)
const txh = () => rnd(32)
const jitter = (a, b) => a + Math.floor(Math.random() * (b - a))

const IMPL = { v2: addr(), evilMint: addr(), evilOwner: addr(), evilFee: addr(), guardian3: addr() }
const SUPPLY = 21_000_000n * 10n ** 18n
const CARD_DEF = {
  evilMint: { kind: 0, target: IMPL.evilMint, rule: 'R1_TOTAL_SUPPLY', added: [] },
  evilOwner: { kind: 0, target: IMPL.evilOwner, rule: 'R2_OWNER', added: [toFunctionSelector('claimOwner()')] },
  evilFee: { kind: 0, target: IMPL.evilFee, rule: 'R3_TRANSFER_CONSERVATION', added: [] },
  v2: { kind: 0, target: IMPL.v2, rule: null, added: [toFunctionSelector('version()')] },
  removeGuardian: { kind: 1, target: IMPL.guardian3, value: 0, rule: 'R7_CONFIG_GUARD', added: [] },
}

function checksFor(card) {
  const ok = (name, before, after = before) => ({ name, before, after, ok: true })
  const bad = (name, before, after) => ({ name, before, after, ok: false })
  const x = 10n ** 18n
  const c = {
    R1_TOTAL_SUPPLY: ok('R1_TOTAL_SUPPLY', SUPPLY.toString()),
    R2_OWNER: ok('R2_OWNER', '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'),
    R3_TRANSFER_CONSERVATION: ok('R3_TRANSFER_CONSERVATION', 'receiver+0', `receiver+${x}`),
    R4_TRANSFER_LIVENESS: ok('R4_TRANSFER_LIVENESS', 'transfer', 'success'),
  }
  if (card === 'evilMint') c.R1_TOTAL_SUPPLY = bad('R1_TOTAL_SUPPLY', SUPPLY.toString(), (SUPPLY + 2n ** 200n).toString())
  if (card === 'evilOwner') c.R2_OWNER = bad('R2_OWNER', '0x70997970c51812dc3a010c7d01b50e0d17dc79c8', '0x' + 'a1'.repeat(20))
  if (card === 'evilFee') c.R3_TRANSFER_CONSERVATION = bad('R3_TRANSFER_CONSERVATION', `receiver+${x}`, `receiver+${(x * 9n) / 10n}`)
  if (card === 'removeGuardian') return [bad('R7_CONFIG_GUARD', 'guardian enabled', 'remove (not approved)')]
  return Object.values(c)
}

// --- servers ---------------------------------------------------------------
let block = 1_000
const offlineUntil = new Map() // sentinel index -> ms
const sentinels = [1, 2, 3].map((i) =>
  createEventServer({
    port: BASE_PORT + i - 1,
    source: `sentinel-${i}`,
    mode: MODE,
    health: () => ({ ok: !isOffline(i), source: `sentinel-${i}`, fake: true, lastBlock: block }),
    routes: {
      'POST /fake/propose': async (b) => ({ ok: true, id: startCard(b.card ?? 'evilMint') }),
      'POST /fake/offline': async (b) => {
        const s = Number(b.sentinel ?? 2)
        offlineUntil.set(s, Date.now() + Number(b.seconds ?? 5) * 1000)
        sentinels[s - 1]?.dropClients()
        return { ok: true, sentinel: s }
      },
    },
  }),
)
const isOffline = (i) => (offlineUntil.get(i) ?? 0) > Date.now()
const driver = WITH_DRIVER ? createEventServer({ port: DRIVER_PORT, source: 'driver', mode: MODE }) : null
const reporter = WITH_REPORTER ? createEventServer({ port: REPORTER_PORT, source: 'reporter', mode: MODE }) : null

for (const s of [...sentinels, driver, reporter].filter(Boolean)) await s.listen()
console.log(`fake events: sentinels on ${BASE_PORT}-${BASE_PORT + 2}${driver ? `, driver ${DRIVER_PORT}` : ''}${reporter ? `, reporter ${REPORTER_PORT}` : ''}; mode=${MODE} auto=${AUTO}`)

// Block clock and heartbeats (500 ms each, per sentinel).
setInterval(() => block++, BLOCK_MS)
setInterval(() => {
  sentinels.forEach((s, k) => {
    if (isOffline(k + 1)) return s.dropClients()
    s.emit('heartbeat', { lastBlock: block, rpc: ['rpc-testnet.monadinfra.com', 'rpc.ankr.com', 'rpc-testnet.monadinfra.com'][k], ok: true })
  })
}, 500)

const waitBlock = async (n) => {
  while (block < n) await sleep(20)
}

// --- scripted proposal -----------------------------------------------------
let nextId = 1
function startCard(card) {
  const def = CARD_DEF[card]
  if (!def) throw new Error(`unknown card ${card}`)
  const id = nextId++
  runCard(id, card, def).catch((e) => console.error(e))
  return id
}

async function runCard(id, card, def) {
  const proposeBlock = block
  const readyBlock = proposeBlock + DELAY
  const codehash = keccak256(stringToBytes(def.target))
  const veto = Boolean(def.rule)
  const ruleHash = veto ? computeRuleHash(def.rule) : null
  const vetoTx = sentinels.map(() => txh())
  console.log(`#${id} ${card} proposeBlock=${proposeBlock} readyBlock=${readyBlock} ${veto ? def.rule : 'pass'}`)

  await Promise.all(
    sentinels.map(async (s, k) => {
      const i = k + 1
      const on = () => !isOffline(i)
      const t0 = Date.now()
      await sleep(jitter(30, 300))
      if (on()) s.emit('proposal_seen', { id, kind: def.kind, target: def.target, codehash, proposeBlock, readyBlock, path: Math.random() < 0.7 ? 'ws' : 'poll' })
      await sleep(5)
      if (on()) s.emit('sim_started', { id })
      const simMs = jitter(320, 520)
      await sleep(simMs)
      if (on())
        s.emit('sim_result', {
          id,
          verdict: veto ? 'veto' : 'pass',
          rule: def.rule,
          ruleHash,
          checks: checksFor(card),
          selectorsAdded: def.added,
          simMs,
        })
      if (!veto) return
      await sleep(jitter(5, 30))
      if (on()) s.emit('veto_sent', { id, txHash: vetoTx[k], rpcs: ['testnet-rpc.monad.xyz', 'rpc-testnet.monadinfra.com', 'rpc.ankr.com'] })
      const b = block + jitter(1, 3)
      await waitBlock(b)
      if (on())
        s.emit('veto_receipt', {
          id,
          txHash: vetoTx[k],
          block: b,
          status: 'success',
          gasUsed: k === 0 ? 61_234 : 44_134,
          gasLimit: 72_000,
          effectiveGasPrice: '102000000000',
          latencyMs: Date.now() - t0,
        })
      await waitBlock(b + 2)
      if (on()) s.emit('veto_finalized', { id, txHash: vetoTx[k], block: b })
    }),
  )

  const reportP = reporter ? fakeReport(id, card, veto) : null

  await waitBlock(readyBlock)
  if (driver) {
    await sleep(100)
    driver.emit('execute_attempt', veto
      ? { id, txHash: txh(), result: 'reverted', error: 'ProposalVetoed' }
      : { id, txHash: txh(), result: 'success', error: null })
  }
  await reportP
}

async function fakeReport(id, card, veto) {
  const text = veto
    ? `提案 #${id} 的新实作在模拟中违反了 ${CARD_DEF[card].rule}：陌生地址或正常转帐的结果与升级前不一致。这类改动会让任何人改写资产或权限，已被哨兵否决。建议多签维持否决，并检查提案者钥匙是否外泄。`
    : `提案 #${id} 的新实作通过全部不变量检查：总量、owner 与转帐守恒都与升级前一致，只新增 version()。建议多签确认来源后让冷静期自然结束。`
  const hash = keccak256(stringToBytes(text))
  await sleep(800)
  for (const ch of [...text]) {
    reporter.emit('report_token', { id, delta: ch })
    await sleep(25)
  }
  reporter.emit('report_done', { id, text, hash, cached: card === 'evilOwner' })
  // The reporter asks sentinel-1 to attach the hash on chain.
  await sleep(600)
  sentinels[0].emit('reason_attached', { id, txHash: txh(), reportHash: hash })
}

if (AUTO) {
  let k = 0
  const loop = async () => {
    for (;;) {
      startCard(CARDS[k++ % CARDS.length])
      await sleep((DELAY + 18) * BLOCK_MS)
    }
  }
  loop()
}

const stop = async () => {
  await Promise.all([...sentinels, driver, reporter].filter(Boolean).map((s) => s.close()))
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
