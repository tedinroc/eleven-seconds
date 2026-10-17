# Eleven Seconds Arena

A cloud, fully interactive version of the demo: a judge presses an attack card on a web page, the
cloud engine proposes the upgrade on Monad testnet, three cloud sentinels judge it independently and
veto it on chain, and the engine executes it at `readyBlock` so the chain records the
`ProposalVetoed` revert. The normal upgrade (v2) passes and goes live after the delay.

The Arena is fully separate from the live demo:

| | Live demo | Arena |
|---|---|---|
| Contracts | `shared/deployments/10143.json` | `shared/deployments/10143-arena.json` (its own GuardedAdmin, proxy, impls) |
| Keys | admin, sentinel1-3 (key files) | its own admin, sentinel1-3 (Worker secrets) |
| URL | local war room | Pages project `eleven-seconds-arena` |
| Code | `sentinel/`, `driver/`, `reporter/`, `web/` (unchanged) | `arena/` (imports the sentinel's and reporter's pure modules read-only) |

The Arena build refuses to bundle if its deployment file points at the live demo's GuardedAdmin.

## Engine (`arena/worker`)

One Cloudflare Worker (`eleven-seconds-arena-engine`, no public hostname: `workers_dev = false`, no
routes) with one SQLite-backed Durable Object `Arena`:

- **Alarm loop**: every `TICK_MS` (1 s) while a proposal is in flight and for `ACTIVE_LINGER_SEC`
  after, every `IDLE_TICK_MS` (4 s) otherwise. Each tick reads the latest block and scans the Arena
  GuardedAdmin's `Proposed` / `Vetoed` / `Executed` / `ReasonAttached` logs with a block cursor
  (at most 100 blocks per `eth_getLogs`). Cursor, proposals, nonces and rate limits are kept in
  Durable Object storage. A cron trigger (every minute) keeps the alarm armed.
- **Cloud sentinels**: every new `Proposed` is judged by each of the three sentinels with the same
  rules as `sentinel/` (R1-R4, R3B by `eth_simulateV1` with the implementation slot overridden; R5
  strict mode, R6 fail-closed, R7, R8, R9 new dangerous opcodes). The code reuses
  `sentinel/src/simulate.mjs`, `bytecode.mjs` and `keys.mjs` as they are, over a fetch-based RPC
  (`src/rpc.mjs`). A violation is vetoed with each sentinel's own key (gas = `shared/gas.json` x 1.25,
  priority fee at least 10 gwei, local nonces). The first vetoing sentinel then sends
  `attachReason(id, keccak256(report))`; the report text comes from the reporter's own template
  (`reporter/src/facts.mjs` + `templates.mjs`) and is served in full by `/api/state`.
- **Cloud driver**: `POST /api/attack` sends `proposeUpgrade(impl, 0x)` from the Arena admin key (fixed
  gas from `shared/gas.json`). At `readyBlock` the engine first `eth_call`s `execute(id)` to read the
  error name, then sends `execute(id)` once: a vetoed proposal reverts `ProposalVetoed` on chain (sent
  with the measured revert gas x 1.25, since Monad charges the gas limit), v2 goes live. If an attack
  card ever reached `readyBlock` without a veto on chain, the engine does not complete it (`held`).

RPC use (Cloudflare egress IPs are shared, the official endpoint limits each IP to 15 req/s): reads,
logs and receipts use `rpc.ankr.com/monad_testnet` then `10143.rpc.thirdweb.com`; `eth_simulateV1`
uses thirdweb first and the official endpoint as the single retry (no `validation` field, explicit gas
on every call); raw transactions go to thirdweb, ankr and the official endpoint at once.

### API

All under `/api/` (the Pages project forwards `/api/*` unchanged through a service binding).

`POST /api/attack` with `content-type: application/json` (anything else gets `415`) and body
`{"card": "evilMint" | "evilOwner" | "evilFee" | "v2" | "v1"}`

- `v1` is accepted only while v2 is live (to bring the token back to v1).
- `200 {"ok": true, "id", "card", "txHash", "proposeBlock", "readyBlock", "delayBlocks"}`
- `202 {"ok": true, "pending": true, "txHash", "id": null}` if the receipt took longer than 8 s (the
  proposal still appears in `/api/state`).
- `429 {"ok": false, "error", "retryAfterSec"}` (and a `Retry-After` header) when a proposal is
  already in flight (one at a time globally), the same visitor attacked less than 45 s ago, or the
  hourly (40) / daily (300, UTC day) cap is reached.
- `400` unknown card, `409` v1 while v2 is not live, `502` propose failed, `503` keys not configured.

`GET /api/state`

```text
{ ok, now, network, chainId, delayBlocks, lastBlock,
  contracts: { guardedAdmin, proxy, proxyAdmin, impls, owner, guardians },
  impl: { address, label: v1|v2|evil*|unknown, at },
  cards: [ { card, impl, kind: attack|upgrade, allowed, reason? } ],
  balances: { at, admin: { address, wei, mon }, sentinels: [ { index, address, wei, mon } ] },
  limits: { ipCooldownSec, hourlyMax, dailyMax, hourUsed, dayUsed, busy, busyRetryAfterSec,
            ipRetryAfterSec (for the caller), hourRetryAfterSec, dayRetryAfterSec },
  active: { id, card, txHash, startedAt } | null,
  engine: { ok, lastBlock, cursor, lastTickAt, lastOkAt, lastTickMs, lastError, lastErrorAt, busy,
            problems: [], ticks, startedAt },
  proposals: [ up to 10, newest first:
    { id, kind, kindName, card, proposer: "arena", proposerAddress, target, codehash,
      proposeTx, proposeBlock, readyBlock, proposedAt, seenAt, seenBlock,
      status: pending|vetoed|executed, verdict: veto|pass,
      sentinels: [ { index, address, verdict, rule, ruleHash, simMs, simRpc, checks, selectorsAdded,
                     extra, vetoTx, vetoSentAt, vetoLatencyMs, vetoBlock, vetoConfirmed, vetoReceipt,
                     vetoError } ],
      chainVetoes: [ { guardian, sentinel, ruleHash, vetoCount, block, txHash } ], vetoCount,
      firstVetoBlock, vetoBlocksAfterPropose, blocksLeftForAttacker,
      report: { text, hash, template: true, rule, bySentinel, attachTx, attachBlock, onchainHash,
                attachConfirmed },
      execute: { result: sent|success|reverted|held|failed, expected, callError (e.g. ProposalVetoed),
                 txHash, block, status },
      executed: { block, txHash, executor } | null,
      cost: { totalWei, totalMon, vetoWei, vetoMon, items: { propose, veto1..3, attachReason,
              execute: { txHash, block, status, gasUsed, gasLimit, effectiveGasPrice, costWei } } } } ] }
```

Costs use gas limit x effective gas price (Monad charges the gas limit).

`GET /api/health`: `{ ok, lastBlock, cursor, lastTickAt, lastOkAt, lastError, busy, active, problems }`.

## Deploy (host)

Prerequisites: the Arena contracts are deployed with their own keys and written to
`shared/deployments/10143-arena.json` (same fields as `10143.json`), e.g.

```sh
RPC_URL=https://testnet-rpc.monad.xyz BROADCAST=1 KEY_DIR=<arena key dir> \
  OUT_JSON=shared/deployments/10143-arena.json script/deploy.sh
```

Fund the Arena keys (they only call contracts): per round the admin spends about
(160,162 propose + 118,005 or 37,352 execute) gas and each vetoing sentinel 123,112 gas (sentinel 1
another 55,174 for `attachReason`), all at gas limit x price. With the priority floor of 10 gwei, a
few MON per key covers a demo day; `/api/state` shows the balances.

1. Worker (build bundles the deployment json, ABIs, rules.json and gas.json):

   ```sh
   cd arena/worker
   npm install
   XDG_CONFIG_HOME=<cf account config dir> npx wrangler@3 deploy
   ```

2. Secrets (one 32-byte hex private key each, read from stdin, never in a file in the repo):

   ```sh
   for k in ADMIN_KEY SENTINEL1_KEY SENTINEL2_KEY SENTINEL3_KEY; do
     XDG_CONFIG_HOME=<cf account config dir> npx wrangler@3 secret put "$k" < <key file for $k>
   done
   ```

   The engine checks that ADMIN_KEY is the deployment's `owner` and SENTINEL1-3_KEY are its
   `guardians`; a mismatch shows up in `engine.problems` and `/api/health` reports `ok: false`.

3. Pages project `eleven-seconds-arena`: a Pages Function `functions/api/[[path]].ts` forwards every
   `/api/*` request unchanged to the engine through a service binding (same pattern as Isotherm):

   ```ts
   export const onRequest = (ctx: { request: Request; env: { ARENA_ENGINE?: { fetch(r: Request): Promise<Response> } } }) =>
     ctx.env.ARENA_ENGINE
       ? ctx.env.ARENA_ENGINE.fetch(ctx.request)
       : new Response(JSON.stringify({ ok: false, error: 'engine binding not configured' }), { status: 503, headers: { 'content-type': 'application/json' } })
   ```

   and in the Pages project's `wrangler.toml`:

   ```toml
   [[services]]
   binding = "ARENA_ENGINE"
   service = "eleven-seconds-arena-engine"
   ```

   The per-visitor limit reads `CF-Connecting-IP`, which the service binding passes through.

4. Check: open `https://<pages>/api/health` (`ok: true`, `lastBlock` moving) and `/api/state`.
   `XDG_CONFIG_HOME=<…> npx wrangler@3 tail eleven-seconds-arena-engine` shows the engine's logs.

Tuning (`[vars]` in `wrangler.toml`): `TICK_MS`, `IDLE_TICK_MS`, `IP_COOLDOWN_SEC`, `HOURLY_MAX`,
`DAILY_MAX`, `MIN_PRIORITY_GWEI`, `GAS_HEADROOM`, `SIM_TIMEOUT_MS`, `SIM_BUDGET_MS`, the RPC lists,
`STRICT`, `SIM_MODE` (`independent`: each sentinel runs its own simulation; `shared`: one simulation,
three signatures, a third of the CPU and RPC use), `ALLOW_ORIGINS` (CORS for a separately hosted page;
empty = same origin only).

Plan notes: every alarm counts as a Durable Object request, so on the free Workers plan keep
`IDLE_TICK_MS` at a few seconds. A judging tick does three simulations' worth of ABI encoding and
decoding plus up to five signatures; if `wrangler tail` ever shows CPU-limit errors on the free plan,
switch `SIM_MODE` to `shared` (or use Workers Paid).

Read-only check against the deployed Arena contracts (no transactions): the judge code in
`src/judge.mjs` returned R1 / R2 / R3 vetoes for evilMint / evilOwner / evilFee and a pass for v2 on
Monad testnet through thirdweb's `eth_simulateV1` (about 1.5-3.5 s per judgment from a cold start).

## Local test

`arena/worker/test/e2e-anvil.mjs` starts its own anvil (`--network monad -b 0.3`, port 8601),
deploys with `script/deploy.sh` into `cache/arena-e2e-8601.json` (never `shared/deployments/*`),
starts `wrangler dev` (port 8787) with anvil's public accounts 1 (admin) and 2/3/4 (sentinels), and
checks the four cards end to end plus the 429 limits. It stops only the processes it started.

```sh
cd arena/worker && npm install && npm run e2e
```

## Web

The Arena page is the existing war room (`web/`) in a new mode, `?mode=arena`, built separately
into `web/dist-arena`. The live demo's modes (`testnet`, `replay`, `fake`, `chain`) and the
`build` / `build:cloud` outputs behave exactly as before; the arena code only runs when the mode is
`arena`.

What the page does:

- Same layout as `?mode=chain`: block header, attacker panel, three sentinel cards, metrics, event
  stream, report dock, 30-block table and the automatic replay of real on-chain events. On-chain
  events are still read directly from Monad testnet in the browser, but from the Arena deployment:
  `web/scripts/sync-arena-data.mjs` copies the public parts of
  `shared/deployments/10143-arena.json` (addresses, GuardedAdmin event/view ABI, rule hashes) into
  `web/src/chain-data-arena.json`, which is bundled. Without that file it writes a placeholder
  (`pending: true`) and the page shows that the Arena contract is not deployed yet.
- Toolbar: one line of explanation ("Press an attack card: cloud sentinels veto it during
  cooldown"), four attack cards (Mint, Takeover, Fee skim, Upgrade v2; keys 1-4 also work), a status
  line, then T (30-block table), R (report), P (pause or resume the replay), language
  (zh-CN / zh-TW / en) and the most recent proposals. On phones and portrait tablets
  (`layout.ts`) the cards become a 2x2 grid of 52 px buttons.
- `POST /api/attack {"card"}`: 200 shows "Sent #id"; 202 (no id yet) shows "Sent, waiting for the
  chain"; 429 shows "Please wait N s" from `Retry-After` / `retryAfterSec` and disables the cards
  until the countdown ends. The request timeout is 20 s (the engine waits up to 12 s for the
  propose receipt); a timeout says the attack was sent and will show up, not that it failed.
- `GET /api/state` every 1.5 s (6 s while the tab is hidden). Each proposal's cloud sentinel
  results (verdict, rule name, simulation ms, veto tx) and the full report text are merged into the
  sentinel cards and the report dock. Facts read from the chain (Vetoed guardian, receipts, block
  numbers) are never overwritten. `limits.busy` / `ipRetryAfterSec` from the engine drive the
  countdown before anyone presses; `engine.ok === false` marks the three sentinel cards offline.
  The report is labelled "template" because the engine serves the reporter's template report.
- Replay: idle pages replay the latest vetoed attack and the latest executed v2 from chain data
  (`replay.ts`). Pressing an attack card, a new proposal appearing in `/api/state` (another
  judge's attack) or a live `Proposed` log stops the replay at once; it resumes after 60 s idle.

Files: `web/src/arena.ts` (API client and merge), `web/src/chaindata.ts` (chooses
`chain-data.json` or `chain-data-arena.json` by mode), the `arena` branches in `config.ts`,
`runtime.ts`, `ui.ts`, `main.ts`, `i18n.ts` (zh-CN / zh-TW / en strings) and the arena-only rules
at the end of `style.css`; tests in `web/test/arena-selftest.ts`.

Checks (no network, no browser):

```sh
cd web
npm run selftest     # the existing selftest, then the arena selftest (buttons, 429, state merge, replay)
npm run build:arena  # sync-arena-data + tsc + vite build --mode arena --outDir dist-arena
cd ../arena/pages
npm test             # Pages Function: forwards /api/* unchanged, 503 without the binding
```

### Page deployment (host)

The Pages project `eleven-seconds-arena` lives in `arena/pages/`:

- `functions/api/[[path]].ts`: forwards every `/api/*` request unchanged (method, path, query,
  headers including `CF-Connecting-IP`, body) to the engine through the service binding `ARENA`
  (`ARENA_ENGINE` is accepted too). Without a binding it answers `503`. Static files never invoke
  the Function.
- `wrangler.toml`: `name = "eleven-seconds-arena"`, `pages_build_output_dir = "./dist"` and

  ```toml
  [[services]]
  binding = "ARENA"
  service = "eleven-seconds-arena-engine"
  ```

  `service` must equal the engine Worker's `name` in `arena/worker/wrangler.toml`; deploy the Worker
  first. If the project was created in the dashboard instead, set the same binding under
  Settings > Bindings > Service binding (variable name `ARENA`).
- `scripts/copy-dist.mjs` copies `web/dist-arena` into `arena/pages/dist`.

```sh
cd arena/pages
# one command: requires shared/deployments/10143-arena.json, builds web/dist-arena, copies it, deploys
XDG_CONFIG_HOME=<cf account config dir> npm run deploy
# which is:
#   node ../../web/scripts/sync-arena-data.mjs --require
#   npm --prefix ../../web run build:arena && node scripts/copy-dist.mjs
#   npx -y wrangler@3 pages deploy --project-name eleven-seconds-arena --branch main --commit-dirty=true
```

The first deploy creates the project (wrangler asks for the production branch; answer `main`).
After deploying, open `https://eleven-seconds-arena.pages.dev/api/health` (engine reachable through
the binding) and the page itself; the badge reads "Monad testnet · cloud interactive" and the
GuardedAdmin address in the header is the Arena one, not the live demo's.

Local preview of the page with the real engine: run the engine with `wrangler dev` (see Local test),
then `npm run build && npm run dev` here (`wrangler pages dev` on port 8788 binds `ARENA` to the
local engine session by name).
