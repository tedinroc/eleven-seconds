// All settings come from environment variables (optionally a CONFIG_FILE with KEY=VALUE lines).
// Paths are resolved relative to the repo root so nothing machine-specific lives in the repo.
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { csv } from './util.mjs'

export const SENTINEL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const REPO_ROOT = resolve(SENTINEL_DIR, '..')

function loadConfigFile(path) {
  if (!path || !existsSync(path)) return {}
  const out = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

const TESTNET_DEFAULTS = {
  RPC_URL: 'https://rpc-testnet.monadinfra.com',
  SIM_RPCS: 'https://testnet-rpc.monad.xyz,https://10143.rpc.thirdweb.com',
  BROADCAST_RPCS: 'https://testnet-rpc.monad.xyz,https://rpc-testnet.monadinfra.com,https://rpc.ankr.com/monad_testnet',
  // Read failover order after RPC_URL (deduplicated): the other getLogs provider, then the official
  // endpoint as a last resort only (spec 4.2.3 keeps the simulation providers for simulation).
  READ_FALLBACKS: 'https://rpc.ankr.com/monad_testnet,https://rpc-testnet.monadinfra.com,https://testnet-rpc.monad.xyz',
  WS_URL: 'wss://rpc-testnet.monadinfra.com',
  WS_FALLBACKS: 'wss://rpc-testnet.monadinfra.com,wss://testnet-rpc.monad.xyz',
  WS_LOGS_KIND: 'monadLogs',
  WS_HEADS_KIND: 'monadNewHeads',
  FINALITY: 'tag',
  DEPLOYMENTS: 'shared/deployments/10143.json',
}
const ANVIL_DEFAULTS = {
  RPC_URL: 'http://127.0.0.1:8545',
  WS_LOGS_KIND: 'logs',
  WS_HEADS_KIND: 'newHeads',
  FINALITY: 'depth:2',
  DEPLOYMENTS: 'shared/deployments/anvil.json',
}

export function loadConfig(env = process.env) {
  const file = loadConfigFile(env.CONFIG_FILE)
  const network = (env.NETWORK ?? file.NETWORK ?? 'anvil').toLowerCase()
  const defaults = network === 'testnet' ? TESTNET_DEFAULTS : ANVIL_DEFAULTS
  const get = (k, d) => env[k] ?? file[k] ?? defaults[k] ?? d
  const path = (p) => (p ? (isAbsolute(p) ? p : resolve(REPO_ROOT, p)) : p)

  const index = Number(get('SENTINEL_INDEX', '1'))
  const rpcUrl = get('RPC_URL')
  const wsDefault = network === 'anvil' ? rpcUrl.replace(/^http/, 'ws') : undefined
  const uniq = (xs) => [...new Set(xs)]
  const wsUrl = get('WS_URL', wsDefault) || null
  const cfg = {
    network,
    mode: get('MODE', network === 'testnet' ? 'testnet' : 'replay'),
    index,
    source: `sentinel-${index}`,
    ssePort: Number(get('SSE_PORT', String(8700 + index))),
    deploymentsPath: path(get('DEPLOYMENTS')),
    gasPath: path(get('GAS_FILE', 'shared/gas.json')),
    rulesPath: path(get('RULES_FILE', 'shared/rules.json')),
    sharedDir: path(get('SHARED_DIR', 'shared')),
    keyFile: get('KEY_FILE'),
    anvilAccount: get('ANVIL_ACCOUNT'),
    rpcUrl,
    // RPC_URL first, then READ_FALLBACKS; READ_RPCS replaces the whole list.
    readRpcs: uniq(csv(get('READ_RPCS', [rpcUrl, ...csv(get('READ_FALLBACKS', ''))].join(',')))),
    readRace: Number(get('READ_RACE', '2')),
    readHedgeMs: Number(get('READ_HEDGE_MS', '800')),
    simRpcs: csv(get('SIM_RPCS', rpcUrl)),
    broadcastRpcs: csv(get('BROADCAST_RPCS', rpcUrl)),
    wsUrl,
    // WS_URL first, then WS_FALLBACKS (rotated on every reconnect after a failure).
    wsUrls: wsUrl ? uniq([wsUrl, ...csv(get('WS_FALLBACKS', ''))]) : [],
    wsConnectTimeoutMs: Number(get('WS_CONNECT_TIMEOUT_MS', '5000')),
    wsStaleMs: Number(get('WS_STALE_MS', '10000')),
    wsLogsKind: get('WS_LOGS_KIND'),
    wsHeadsKind: get('WS_HEADS_KIND'),
    pollMs: Number(get('POLL_MS', '300')),
    pollOffsetMs: Number(get('POLL_OFFSET_MS', String((index - 1) * 100))),
    heartbeatMs: Number(get('HEARTBEAT_MS', '500')),
    getLogsMaxRange: Number(get('GETLOGS_MAX_RANGE', '100')),
    lookbackBlocks: Number(get('LOOKBACK_BLOCKS', '60')),
    rescanBlocks: Number(get('RESCAN_BLOCKS', '10')),
    backfillMax: Number(get('BACKFILL_MAX', '200')),
    vetoRetryMs: Number(get('VETO_RETRY_MS', '200')),
    replaceAfterMs: Number(get('VETO_REPLACE_AFTER_MS', '4000')),
    attachSecret: get('ATTACH_SECRET', '') || null,
    strict: get('STRICT', '0') === '1',
    simTimeoutMs: Number(get('SIM_TIMEOUT_MS', '2500')),
    simBudgetMs: Number(get('SIM_BUDGET_MS', '5000')),
    simCallGas: BigInt(get('SIM_CALL_GAS', '300000')),
    simReadGas: BigInt(get('SIM_READ_GAS', '100000')),
    simMaxCalls: Number(get('SIM_MAX_CALLS', '150')),
    // eth_chainId on every idle client (simulation, read fallbacks, broadcast) so no request pays a
    // new TLS handshake; SIM_WAIT_PING_MS: a simulation that finds the ping on the warm socket waits.
    keepaliveMs: Number(get('KEEPALIVE_MS', get('SIM_KEEPALIVE_MS', network === 'testnet' ? '12000' : '0'))),
    simWaitPingMs: Number(get('SIM_WAIT_PING_MS', '600')),
    finality: get('FINALITY'),
    feeRefreshMs: Number(get('FEE_REFRESH_MS', '10000')),
    rpcTimeoutMs: Number(get('RPC_TIMEOUT_MS', '4000')),
    dryRun: get('DRY_RUN', '0') === '1',
    attach: get('ATTACH', index === 1 ? '1' : '0') === '1',
    chainId: get('CHAIN_ID') ? Number(get('CHAIN_ID')) : null,
  }
  if (!cfg.keyFile && cfg.anvilAccount == null) throw new Error('set KEY_FILE (path to a hex private key) or ANVIL_ACCOUNT (anvil only)')
  if (network === 'testnet' && cfg.anvilAccount != null) throw new Error('ANVIL_ACCOUNT is only allowed with NETWORK=anvil')
  return cfg
}
