#!/usr/bin/env node
// Arena engine end-to-end on a private anvil (anvil only: anvil's public test accounts, derived from
// its well-known mnemonic at run time). Starts its own anvil (--network monad, 0.3 s blocks), deploys
// the demo contracts with script/deploy.sh into cache/arena-e2e-<port>.json (never shared/deployments/*), starts
// `wrangler dev` with that deployment and anvil accounts 1 (admin) and 2/3/4 (sentinels), then:
//   - v1 card refused while v1 is live (409)
//   - evilMint, evilOwner, evilFee: all three cloud sentinels veto (R1 / R2 / R3), execute reverts
//     ProposalVetoed on chain, the template report hash is attached on chain
//   - a second attack while one is in flight -> 429 (busy); right after one finishes -> 429 (per-IP)
//   - v2: all three pass, execute succeeds, proxy implementation == v2 and version() == "2"
// Processes are stopped by their own PIDs only.
//
//   node test/e2e-anvil.mjs        (ANVIL_PORT=8601 WORKER_PORT=8787 E2E_DIR=<scratch dir>)
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, join, resolve, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, http, keccak256, stringToBytes, decodeFunctionResult, encodeFunctionData, toHex } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'

const WORKER = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = resolve(WORKER, '..', '..')
const ANVIL_PORT = Number(process.env.ANVIL_PORT ?? 8601)
const WORKER_PORT = Number(process.env.WORKER_PORT ?? 8787)
const RPC = `http://127.0.0.1:${ANVIL_PORT}`
const API = `http://127.0.0.1:${WORKER_PORT}`
const DIR = process.env.E2E_DIR ? resolve(process.env.E2E_DIR) : mkdtempSync(join(tmpdir(), 'arena-e2e-'))
mkdirSync(DIR, { recursive: true })
// forge's fs_permissions only allow writes under ./cache and ./shared/deployments: use cache/ (gitignored).
const OUT_JSON = join(REPO, 'cache', `arena-e2e-${ANVIL_PORT}.json`)
const IP_COOLDOWN = 20
const PATH = [join(homedir(), '.foundry', 'bin'), process.env.PATH].join(delimiter)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const MN = 'test test test test test test test test test test test junk'
const pk = (i) => toHex(mnemonicToAccount(MN, { addressIndex: i }).getHdKey().privateKey)

const procs = []
let failures = 0
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`)
  if (!cond) failures++
}
function start(name, cmd, args, opts = {}) {
  const p = spawn(cmd, args, { ...opts, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = []
  p.stdout.on('data', (d) => log.push(String(d)))
  p.stderr.on('data', (d) => log.push(String(d)))
  procs.push({ name, p, log })
  console.log(`started ${name} pid ${p.pid}`)
  return { p, log }
}
function stopAll() {
  for (const { name, p } of procs.reverse()) {
    try {
      process.kill(-p.pid, 'SIGTERM') // the process group we created (detached), by PID
      console.log(`stopped ${name} pid ${p.pid}`)
    } catch {}
  }
}
process.on('exit', stopAll)
process.on('SIGINT', () => process.exit(130))

async function waitFor(fn, ms, what) {
  const t = Date.now()
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch {}
    if (Date.now() - t > ms) throw new Error(`timeout waiting for ${what}`)
    await sleep(300)
  }
}
const api = async (path, init) => {
  const r = await fetch(API + path, init)
  return { status: r.status, body: await r.json().catch(() => null) }
}
const attack = (card) => api('/api/attack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ card }) })
const state = async () => (await api('/api/state')).body

try {
  // ---------------------------------------------------------------- anvil + deploy
  const anvil = start('anvil', 'anvil', ['--network', 'monad', '-b', '0.3', '--port', String(ANVIL_PORT), '--silent'], { env: { ...process.env, PATH } })
  const pub = createPublicClient({ transport: http(RPC) })
  await waitFor(() => pub.getChainId(), 15_000, 'anvil')
  if ((await pub.getChainId()) !== 31337) throw new Error('not anvil')

  // deploy.sh rewrites broadcast/Deploy.s.sol/31337/run-latest.json: keep and restore any existing one.
  const runLatest = join(REPO, 'broadcast', 'Deploy.s.sol', '31337', 'run-latest.json')
  const backup = existsSync(runLatest) ? join(DIR, 'run-latest.backup.json') : null
  if (backup) copyFileSync(runLatest, backup)
  try {
    execFileSync('bash', ['script/deploy.sh'], { cwd: REPO, env: { ...process.env, PATH, RPC_URL: RPC, OUT_JSON }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 })
  } finally {
    if (backup) copyFileSync(backup, runLatest)
  }
  const dep = JSON.parse(readFileSync(OUT_JSON, 'utf8'))
  console.log(`deployed guardedAdmin ${dep.guardedAdmin} (scratch deployment file)`)
  const abiOf = (n) => {
    const j = JSON.parse(readFileSync(join(REPO, 'shared', 'abi', `${n}.json`), 'utf8'))
    return Array.isArray(j) ? j : j.abi
  }
  const gaAbi = abiOf('GuardedAdmin')
  const tokenAbi = abiOf('DemoBTC')

  // ---------------------------------------------------------------- wrangler dev
  const vars = {
    READ_RPCS: RPC, SIM_RPCS: RPC, BROADCAST_RPCS: RPC,
    ADMIN_KEY: pk(1), SENTINEL1_KEY: pk(2), SENTINEL2_KEY: pk(3), SENTINEL3_KEY: pk(4),
    IP_COOLDOWN_SEC: String(IP_COOLDOWN), MIN_PRIORITY_GWEI: '1', IDLE_TICK_MS: '1000', BLOCK_MS: '300',
  }
  const args = ['dev', '--port', String(WORKER_PORT), '--ip', '127.0.0.1', '--inspector-port', String(WORKER_PORT + 452), '--persist-to', join(DIR, 'wrangler-state'), '--show-interactive-dev-session=false']
  for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`)
  const wr = start('wrangler', join(WORKER, 'node_modules', '.bin', 'wrangler'), args, {
    cwd: WORKER, env: { ...process.env, PATH, ARENA_DEPLOYMENT: OUT_JSON, WRANGLER_SEND_METRICS: 'false', CI: '1' },
  })
  await waitFor(async () => (await api('/api/health')).status === 200, 90_000, 'wrangler dev').catch((e) => {
    console.log(wr.log.join('').slice(-3000))
    throw e
  })
  const st0 = await waitFor(async () => {
    const s = await state()
    return s?.engine?.lastOkAt && s.impl ? s : null
  }, 30_000, 'first engine tick')
  ok(st0.contracts.guardedAdmin === dep.guardedAdmin.toLowerCase(), 'engine reads the scratch deployment')
  ok(st0.engine.problems.length === 0, `engine keys match deployment roles ${JSON.stringify(st0.engine.problems)}`)
  ok(st0.impl.label === 'v1', `current implementation is v1 (${st0.impl.label})`)

  const noJson = await api('/api/attack', { method: 'POST', body: JSON.stringify({ card: 'v2' }) })
  ok(noJson.status === 415, `attack without a JSON content type -> 415 (${noJson.status})`)
  const bad = await attack('nope')
  ok(bad.status === 400, `unknown card -> 400 (${bad.status})`)
  const v1early = await attack('v1')
  ok(v1early.status === 409, `v1 card refused while v1 is live -> 409 (${v1early.status})`)

  const EXPECT = { evilMint: 'R1_TOTAL_SUPPLY', evilOwner: 'R2_OWNER', evilFee: 'R3_TRANSFER_CONSERVATION' }
  const cards = ['evilMint', 'evilOwner', 'evilFee', 'v2']
  for (const [n, card] of cards.entries()) {
    // ---- launch (wait out the per-IP cooldown of the previous round)
    let res = await attack(card)
    if (res.status === 429 && n > 0) {
      ok(/45 seconds|visitor/.test(res.body?.error ?? '') && res.body.retryAfterSec > 0, `per-IP cooldown right after a round -> 429 retryAfter ${res.body?.retryAfterSec}s`)
      await sleep((res.body.retryAfterSec + 1) * 1000)
      res = await attack(card)
    }
    ok(res.status === 200 && res.body?.ok && res.body.id > 0, `${card}: attack accepted id=${res.body?.id} propose ${res.body?.proposeBlock} ready ${res.body?.readyBlock}`)
    ok(typeof res.body?.txHash === 'string' && res.body.readyBlock - res.body.proposeBlock === dep.delayBlocks, `${card}: response has txHash, proposeBlock, readyBlock (+${dep.delayBlocks})`)
    const id = res.body.id
    if (n === 0) {
      const busy = await attack('evilOwner')
      ok(busy.status === 429 && /in flight/.test(busy.body?.error ?? '') && busy.body.retryAfterSec > 0, `second attack while one is in flight -> 429 (retryAfter ${busy.body?.retryAfterSec}s)`)
    }
    // ---- wait for the engine to finish the round (execute receipt)
    const done = await waitFor(async () => {
      const s = await state()
      const p = s?.proposals?.find((x) => x.id === id)
      return p?.execute?.status && (!p.report?.attachTx || p.report.attachConfirmed) ? { s, p } : null
    }, 60_000, `${card} round`)
    const p = done.p
    const onchain = await pub.readContract({ address: dep.guardedAdmin, abi: gaAbi, functionName: 'getProposal', args: [BigInt(id)] })
    if (EXPECT[card]) {
      ok(p.sentinels.length === 3 && p.sentinels.every((s) => s.verdict === 'veto'), `${card}: 3/3 cloud sentinels veto (${p.sentinels.map((s) => s.rule).join(', ')})`)
      ok(p.sentinels.every((s) => s.rule === EXPECT[card]), `${card}: rule ${EXPECT[card]}`)
      ok(Number(onchain.status) === 2 && Number(onchain.vetoCount) === 3, `${card}: on chain Vetoed with vetoCount 3 (status ${onchain.status}, count ${onchain.vetoCount})`)
      ok(p.firstVetoBlock != null && p.firstVetoBlock < p.readyBlock, `${card}: veto landed ${p.vetoBlocksAfterPropose} blocks after propose, ${p.blocksLeftForAttacker} blocks before readyBlock`)
      ok(p.execute.result === 'reverted' && p.execute.callError === 'ProposalVetoed', `${card}: execute sent once and reverted ProposalVetoed (${p.execute.result}/${p.execute.callError})`)
      ok(p.report?.text?.length > 20 && p.report.hash === keccak256(stringToBytes(p.report.text)), `${card}: template report kept, hash = keccak256(text)`)
      ok(p.report?.onchainHash === p.report?.hash, `${card}: ReasonAttached hash on chain equals the report hash`)
    } else {
      ok(p.sentinels.length === 3 && p.sentinels.every((s) => s.verdict === 'pass'), `${card}: 3/3 cloud sentinels pass`)
      ok(p.execute.result === 'success' && p.status === 'executed' && Number(onchain.status) === 3, `${card}: executed after the delay (status ${onchain.status})`)
      const slot = await pub.getStorageAt({ address: dep.proxy, slot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' })
      ok(('0x' + slot.slice(26)).toLowerCase() === dep.impls.v2.toLowerCase(), `${card}: proxy implementation is v2`)
      const ver = decodeFunctionResult({ abi: tokenAbi, functionName: 'version', data: (await pub.call({ to: dep.proxy, data: encodeFunctionData({ abi: tokenAbi, functionName: 'version' }) })).data })
      ok(ver === '2', `${card}: version() == "2"`)
    }
    ok(BigInt(p.cost?.totalWei ?? 0) > 0n, `${card}: cost recorded (${p.cost?.totalMon} MON)`)
    console.log(`  #${id} ${card}: sim ${p.sentinels.map((s) => s.simMs + 'ms').join('/')}, execute ${p.execute.result}`)
  }
  const fin = await state()
  ok(fin.impl?.label === 'v2' && fin.cards.find((c) => c.card === 'v1')?.allowed === true, 'v1 card offered once v2 is live')
  ok(fin.proposals.length >= 4 && fin.balances?.sentinels?.length === 3 && fin.limits?.hourUsed >= 4, `/api/state: proposals ${fin.proposals.length}, balances, limits hourUsed ${fin.limits?.hourUsed}`)
  const h = await api('/api/health')
  ok(h.status === 200 && h.body?.ok === true, `/api/health ok (lastError ${h.body?.lastError ?? 'none'})`)
} catch (e) {
  failures++
  console.error(`ERROR ${e.stack ?? e.message}`)
  const wr = procs.find((x) => x.name === 'wrangler')
  if (wr) console.error(wr.log.join('').slice(-4000))
} finally {
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
  stopAll()
  process.exitCode = failures ? 1 : 0
  setTimeout(() => process.exit(process.exitCode), 500)
}
