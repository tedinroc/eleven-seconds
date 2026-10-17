# Sentinel notes

Three independent sentinel processes (same code, own key, own primary RPC, own SSE port) watch
`Proposed` on GuardedAdmin, simulate the proposed implementation with `eth_simulateV1` + stateOverride,
and veto on any invariant violation (spec section 4). Fail-closed: any simulation failure on both
providers, a reverting view, or an internal error is an R6 veto.

## Run

```sh
# local replay (anvil's public test accounts 2/3/4 as sentinel1-3; anvil on 8545)
sh sentinel/run.sh anvil
# another anvil / deployments file
RPC_URL=http://127.0.0.1:8547 DEPLOYMENTS=cache/x.json BASE_PORT=8721 sh sentinel/run.sh anvil

# Monad testnet 10143 (reads shared/deployments/10143.json); keys are read at run time from files
KEY_DIR=<dir with sentinel1.key ...> sh sentinel/run.sh testnet
DRY_RUN=1 KEY_DIR=... sh sentinel/run.sh testnet      # judge + sign, never broadcast
STRICT=1 ...                                           # R5: unapproved codehash is always vetoed

# fake SSE for the frontend (no chain): sentinels on 8701-8703, optional driver 8700 / reporter 8710
node sentinel/fake-events.mjs
FAKE_DRIVER=1 FAKE_REPORTER=1 FAKE_AUTO=0 node sentinel/fake-events.mjs
curl -XPOST localhost:8701/fake/propose -d '{"card":"evilFee"}'      # evilMint|evilOwner|evilFee|v2|removeGuardian
curl -XPOST localhost:8701/fake/offline -d '{"sentinel":2,"seconds":5}'

# checks
node --test sentinel/test/unit.test.mjs                 # offline
RPC_URL=http://127.0.0.1:8547 DEPLOYMENTS=cache/x.json SSE_PORTS=8721,8722,8723 ROUNDS=5 \
  KILL_PORT=8722 KILL_AFTER_ROUND=3 node sentinel/test/e2e-anvil.mjs
node sentinel/test/sim-latency.mjs                      # read-only eth_simulateV1 latency probe
```

`node_modules`: `run.sh` tries `npm install --offline`, else links `../scripts/node_modules` (viem 2.57.2).

## Settings (environment, or `CONFIG_FILE` with KEY=VALUE lines)

| Variable | Default (anvil / testnet) | Meaning |
|---|---|---|
| `NETWORK` | `anvil` | `anvil` or `testnet` (selects the defaults below) |
| `SENTINEL_INDEX` | 1 | 1..3; source name `sentinel-N`, default SSE port 870N |
| `DEPLOYMENTS` | `shared/deployments/anvil.json` / `10143.json` | repo-relative or absolute |
| `GAS_FILE`, `RULES_FILE`, `SHARED_DIR` | `shared/gas.json`, `shared/rules.json`, `shared` | |
| `KEY_FILE` | — | file with one hex private key (read at run time, never printed) |
| `ANVIL_ACCOUNT` | — | anvil only: index into anvil's public test mnemonic; refused unless chainId 31337 |
| `RPC_URL` | `127.0.0.1:8545` / `rpc-testnet.monadinfra.com` | primary for getLogs polling, heartbeat, eth_call, receipts, nonce, fees |
| `READ_FALLBACKS` | — / ankr,monadinfra,official | appended to `RPC_URL` (deduplicated) to form the sticky read failover chain |
| `READ_RPCS` | — | replaces the whole read chain (`RPC_URL` + `READ_FALLBACKS`) |
| `READ_RACE`, `READ_HEDGE_MS` | 2, 800 | newImpl `eth_getCode` on proposal_seen is raced over the first N of the read chain; the rest of the chain joins if nothing matched after 800 ms |
| `SIM_RPCS` | `RPC_URL` / official,thirdweb | eth_simulateV1 only; primary rotates by index, the other is the retry |
| `BROADCAST_RPCS` | `RPC_URL` / official,monadinfra,ankr | first uses eth_sendRawTransactionSync; any one accepting is enough |
| `WS_URL`, `WS_FALLBACKS` | ws form of RPC_URL / per process in run.sh; monadinfra,official | logs + heads subscription; reconnects rotate over WS_URL + WS_FALLBACKS |
| `WS_CONNECT_TIMEOUT_MS`, `WS_STALE_MS` | 5000, 10000 | a WS that never opens / goes silent is closed and reconnected |
| `WS_LOGS_KIND`, `WS_HEADS_KIND` | `logs`,`newHeads` / `monadLogs`,`monadNewHeads` | |
| `POLL_MS`, `POLL_OFFSET_MS` | 300, (index-1)*100 | getLogs poll period and stagger |
| `GETLOGS_MAX_RANGE`, `LOOKBACK_BLOCKS` | 100, 60 | cursor = last processed + 1, at most 100 blocks per request |
| `HEARTBEAT_MS` | 500 | |
| `SIM_TIMEOUT_MS`, `SIM_BUDGET_MS` | 2500, 5000 | per request / total including the one retry (R6) |
| `SIM_CALL_GAS`, `SIM_READ_GAS`, `SIM_MAX_CALLS` | 300000, 100000, 150 | explicit gas on every simulated call |
| `KEEPALIVE_MS` (old name `SIM_KEEPALIVE_MS`) | 0 / 12000 | eth_chainId on every client idle that long (simulation, read fallbacks, broadcast) |
| `SIM_WAIT_PING_MS` | 600 | a simulation that finds the keep-warm ping on the warm socket waits for it instead of opening a new one |
| `FINALITY` | `depth:2` / `tag` | `tag` = `eth_getBlockByNumber("finalized")` |
| `FEE_REFRESH_MS` | 10000 | |
| `VETO_MIN_PRIORITY_GWEI` | 10 | floor for the veto priority fee (gwei) so a veto is not queued behind cheaper traffic; adds about 0.001 MON per veto |
| `GAS_HEADROOM` | 1.25 | multiplier on gas.json limits (see "Gas headroom") |
| `STRICT`, `DRY_RUN`, `ATTACH` | 0, 0, 1 on sentinel-1 only | |
| `ATTACH_SECRET` | — | shared secret for `POST /attach` (header `X-Attach-Secret`); unset = loopback peers only |
| `RESCAN_BLOCKS` | 10 | every poll round re-scans the last N blocks (dedupe by id absorbs repeats) |
| `BACKFILL_MAX` | 200 | at start, `getProposal` on the last N ids: Pending with readyBlock > latest are judged |
| `VETO_RETRY_MS` | 200 | first backoff of a failed veto broadcast (doubles to 2 s, jittered), retried while lastBlock < readyBlock |
| `VETO_REPLACE_AFTER_MS` | 4000 | no receipt that long and the chain nonce did not move: re-send the same nonce at +25% fee (max 3) |

Ports: SSE `127.0.0.1:870{1,2,3}` with `GET /events` (`?backlog=N` replays the last N events,
default 0), `GET /health`, and `POST /attach {"id":N,"reportHash":"0x.."}` on sentinel-1 only.

`POST /attach` spends the guardian's nonce and gas, so it is not a CORS endpoint: no
`Access-Control-Allow-Origin` (also not on its preflight), `content-type: application/json` required
(415 otherwise; a cross-site "simple request" cannot carry it), and with `ATTACH_SECRET` set the
request must carry `X-Attach-Secret: <secret>` (401 otherwise); without a secret only peers on
127.0.0.1 / ::1 are accepted. Before signing, `getProposal(id)` (eth_call) must show a known
proposal (status != None), else 400 `unknown proposal`. `/events` and `/health` keep `ACAO: *` for
the frontend.

## RPC transport

- One client per URL for the whole process (`clientFor` in `src/rpc.mjs`): `node:https` with an
  explicit `Agent({ keepAlive: true, scheduling: 'lifo' })`, no fetch/undici. Polling, reads,
  simulation and broadcast that hit the same provider share its warm socket. `GET /health` shows
  `sockets` (new vs reused per provider) and `rpcSwitches`.
- Keep-warm: every client idle for `KEEPALIVE_MS` (12 s on testnet) gets one `eth_chainId`; the
  polled primary is never idle so it is never pinged. Measured: both simulation providers keep an
  idle socket for at least 30 s, so 12 s has margin. Budget per sentinel: at most 3 pings per 12 s
  (official, thirdweb, the idle read fallback); 3 sentinels = 0.25 req/s on official (limit 15/s per
  IP) and 0.25 req/s on thirdweb. Negligible next to polling.
- Critical path on proposal_seen (kind 0): only `eth_getCode(newImpl)` is awaited before the
  simulation. It is raced over the first `READ_RACE` read providers (the first answer whose keccak
  equals the proposal's codehash wins, so a lagging node's `0x` cannot cause an R6). Holder balance
  and the current implementation's selectors come from the 5 s background refresh; the selectors
  are only needed after the simulation (selectorsAdded is informational, never the verdict).
  Keeping these reads off the critical path avoids opening extra TLS connections next to the busy
  polling socket.
- Failover: every read goes through a sticky chain (`createFailover`); a transport error (tls
  handshake eof, ECONNRESET, socket hang up, timeout, `HTTP request failed`, HTTP 429/5xx, rate-limit
  messages) retries the same call on the next provider at once, which stays active (the primary is
  retried after 60 s). JSON-RPC answers such as `execution reverted` never fail over. The official
  endpoint is the last read fallback only; while polling has fallen back to it, the poll period is
  at least 1 s so three sentinels stay well under its 15 req/s per IP that the simulations share.
- Simulation: primary by sentinel index, the other provider is the single retry (spec 4.2.2). A
  provider whose last request or keep-warm ping died on the transport in the last 30 s is tried
  second, so a dead endpoint does not cost every proposal a failed attempt first.
- Broadcast: the same raw tx goes to every `BROADCAST_RPCS` at once and the first acceptance wins
  (`already known` counts). If every RPC failed on the transport, the same raw tx is resent once
  immediately.
- WS: exponential backoff with jitter 0.5 s -> 15 s, reset only after a connection stayed up 10 s;
  connect timeout 5 s (Node's WebSocket did not report a refused connection quickly in testing, the
  timeout caught it); silent for 10 s = dead. getLogs polling runs all the time, so a dead WS costs
  nothing but the WS path.

## Judging

- Upgrade (kind 0): R5 (STRICT and codehash not approved) and R8 (non-empty data and the
  codehash+data key not approved) are decided without simulating. Otherwise one merged
  `eth_simulateV1` request, one block: baseline reads → a funded holder transfers 1% of its balance
  to a fresh address → reads → stranger `transferFrom(holder, stranger, X)` (R3B) → every selector
  found in the new bytecode × 5 argument sets + 2 fallback probes from a fresh stranger → reads
  (totalSupply, owner, every watched balance). About 100 calls for the demo impls (15 selectors).
  The request never contains a `validation` field.
- When several invariants break, the reported rule is the first of R4, R3, R2, R1, R3B (so EvilOwner,
  whose `claimOwner` also unlocks `mint`, reports R2).
- Probes (per selector, from a fresh stranger): none / stranger / stranger+2^128 / 2^128 / a wide
  set of 8 words `(stranger, 2^128, 2^128, stranger, 0, 0, 0, 0)` so 3+ argument backdoors decode,
  plus two fallback probes (empty calldata, random unknown selector + 3 words). Selector extraction
  accepts PUSH1-PUSH4 (left-padded to 4 bytes; solc emits PUSH3 for `0x00dca85e`); the short pushes
  must sit in the dispatcher shape `DUPn PUSHk sel [DUPn] EQ|GT|LT PUSHm dest JUMPI`.
- If the probes do not all fit in `SIM_MAX_CALLS` (truncated), the verdict is **R6** (fail-closed);
  the request is not split.
- R4/R3 use the first holder with balance > 0 (all holders' balances refreshed every 5 s); if every
  holder is at 0, R6.
- **R3B_THIRD_PARTY_FUNDS**: after the holder transfer the stranger calls
  `transferFrom(holder, stranger, X)` with no allowance; it must revert (or return false). After the
  probes every watched balance (deployments `owner`, `tokenOwner`, holders, receiver) is re-read and
  must equal its value before the stranger calls. Priority R4, R3, R2, R1, R3B.
- **R9_NEW_OPCODES** (static, only after a passing simulation): the new code contains one of ORIGIN,
  BLOCKHASH, COINBASE, TIMESTAMP, NUMBER, PREVRANDAO, GAS, CALL, CALLCODE, DELEGATECALL, STATICCALL,
  CREATE, CREATE2, SELFDESTRUCT that the current implementation (ERC-1967 slot) does not have, and
  the codehash is not approved. The walker skips PUSH data and the CBOR metadata tail. v1, v2,
  EvilMint, EvilOwner, EvilFee and PausedImpl contain none of them (unit test), so v2 passes. An
  unreadable current implementation is compared against the empty set.
- Config proposals (kinds 1-3) are R7 when they weaken the guard: **any** SetGuardian (adding a
  guardian too: one rogue guardian can breakGlass and veto every way out), lowering the delay, any
  SetPausedImpl.

### Approval keys (what the approver must pass to `approveCodehash`)

Looked up with `isApprovedCodehash(bytes32)`; sentinel-side convention, contract unchanged
(`src/keys.mjs`). `sim_result.extra.approvalKey` shows the key the sentinel looked up.

| Proposal | Key |
|---|---|
| R7: SetGuardian / SetDelay / SetPausedImpl (kinds 1, 2, 3) | `keccak256(abi.encode(uint8 kind, address target, uint256 value))`. SetGuardian: value 1 = add, 0 = remove; SetDelay: target `address(0)`, value = new delay; SetPausedImpl: value 0 (an upgrade codehash approval does not cover it) |
| R8: upgrade with non-empty `data` | `keccak256(abi.encode(bytes32 codehash, bytes32 keccak256(data)))` |
| R5 (STRICT) and the R9 exemption | the implementation's `codehash` itself |

```js
// viem
actionHash = keccak256(encodeAbiParameters([{type:'uint8'},{type:'address'},{type:'uint256'}], [kind, target, value]))
dataKey    = keccak256(encodeAbiParameters([{type:'bytes32'},{type:'bytes32'}], [codehash, keccak256(data)]))
```
```sh
cast keccak $(cast abi-encode "f(uint8,address,uint256)" 1 0xGuardian 1)
cast keccak $(cast abi-encode "f(bytes32,bytes32)" 0xCodehash $(cast keccak 0xDATA))
```
- The current implementation is read from the ERC-1967 slot (derived exactly as OZ defines it,
  checked against `ERC1967Utils.sol` in the unit test) to compute `selectorsAdded`.

## SSE details beyond spec 4.4 (all extra data lives in `extra`)

- Amounts in wei / token units are decimal strings (`effectiveGasPrice`, `checks[].before/after`);
  blocks, gas, ms are numbers.
- `sim_result.extra`: `culprits` (probe selector + args whose logs show a mint/burn or ownership move),
  `skimmedTo` (watchlist addresses that received value during the plain transfer), `selectorsRemoved`,
  `probes`, `calls`, `simRpc`, `simRequestMs`, `retried`, `errors` (R6).
- `veto_sent` is emitted once the first broadcast RPC accepted the raw tx (`extra.acceptedBy`,
  `extra.attempt`); `veto_receipt.extra` has `vetoBlocksAfterPropose`, `blocksLeftForAttacker` and
  `replacedFrom` when a fee-bumped replacement was the one mined.
- `veto_failed` (new type) `{ id, extra: { attempts, error, readyBlock, lastBlock } }`: every
  broadcast attempt failed until lastBlock >= readyBlock. Retries back off 200 ms → 2 s and re-sync
  the nonce from the **pending** count each round (also at start). "replacement transaction
  underpriced" is a nonce error, not a delivery.
- `proposal_seen.extra.backfill: true` when found by the startup `getProposal` scan.
- `sim_result.extra`: also `thirdPartyDeltas` (R3B), `newOpcodes` (R9), `approvalKey` (R7/R8),
  `truncated` (R6).
- `reason_attached` is emitted once the attachReason tx has been accepted.

## Measurements

| What | Result |
|---|---|
| eth_simulateV1, official, 20-call request, kept-alive (2026-10-17 11:38 UTC+8, operator's network) | 314–355 ms; connection setup + first call 1098 ms |
| same, thirdweb | 367–450 ms; setup 1156 ms; no 429 in 6 sequential requests |
| R6 timeouts | kept at 2500 ms per request / 5000 ms budget: about 6x the kept-alive latency, and a retry still fits |
| anvil `--network monad -b 0.3`, 3 sentinels, 5 rounds × 4 cards (evilMint, evilOwner, evilFee, v2) | 0 wrong verdicts; every veto landed 1 block after the proposal (29 blocks left); proposal_seen → veto_receipt 299–309 ms; vetoed execute → `ProposalVetoed`; v2 executes after 30 blocks, `version()` = "2" |
| kill sentinel-2 after round 3 (SIGKILL) | its heartbeats stop immediately; rounds 4–5 vetoed by the other two (vetoCount 2), 0 failures |
| testnet, first round with cold connections (2026-10-17, venue network, EvilMint #1) | simMs 2236/2573/2308 of which simRequestMs 1399/804/689; the rest was new TLS connections |
| dedupe | every proposal arrived on both WS and polling (20 duplicates dropped per sentinel in 20 proposals); one proposal_seen and at most one veto per sentinel |
| R7 / R8 on anvil | remove guardian → R7, add guardian → R7, delay 30→10 → R7, 30→40 → pass, upgrade with init data → R8 |

### Cold vs kept-alive on Monad testnet (`node test/sim-latency.mjs`, read-only, 2026-10-17 ~12:00 UTC+8, operator's network)

Real merged request for the deployed EvilMint impl (73 calls, 14.8 kB, same builder as the sentinel; both providers answer veto R1). Two runs, ms.

| | cold (new TLS connection) | kept alive |
|---|---|---|
| eth_getCode, ankr | 1350, 1358 | 415–507 |
| eth_getCode, monadinfra | 1082, 1146 | 332–428 |
| eth_getCode raced over both | — | 346–653 (monadinfra won every time) |
| eth_simulateV1, official | 1632, 1711 | 442–962 |
| eth_simulateV1, thirdweb | 1528, 1649 | 551–1225 |

- Idle socket reuse: after 5 / 12 / 20 / 30 s idle both simulation providers still reused the same
  socket (eth_chainId 282–637 ms). After 25 s idle with `keepWarm` at 12 s: one ping, then the
  simulation reused the socket (590–736 ms). 13 requests per provider used 1 connection, 0 errors.
- Critical path the sentinel runs (getCode race + simulateV1, warm sockets): typically official
  1076–1257 ms, thirdweb 914–1177 ms. `READ_HEDGE_MS` lets the third read provider join after
  800 ms when the first two have not answered. Live testnet results are in the main README.
- anvil (`-b 0.3`, 8547): normal config 3 + 4 rounds (the second with sentinel-2 SIGKILLed after
  round 2) 0 wrong verdicts, veto +1 block. Dead primaries for read, simulation, broadcast and WS
  (`READ_RPCS`/`SIM_RPCS`/`BROADCAST_RPCS` = dead port first, `WS_URL` dead with a fallback):
  5 rounds 0 failures, veto +1 block, WS on the fallback after the 5 s connect timeout. Dead getCode
  racer (`READ_RACE=1`): the hedge starts as soon as the racer fails (codeMs about 10 ms), 0 failures.

Testnet numbers (proposal_seen → veto_receipt, veto block, gas cost) are in the main README, section
"Measured today on Monad testnet".

## Gas headroom

- On anvil `--network monad` a first veto uses 89,535–100,335 gas depending on cold SLOADs (four at
  8,100 each). The sentinel multiplies gas.json limits by `GAS_HEADROOM` (default 1.25 → 123,112)
  so every case fits without gas estimation. Monad charges the gas limit, so the headroom is part of
  the per-veto cost.

## Extended attack suite (2026-10-17)

`test/e2e-attacks.mjs` deploys an extended set of attack implementations (`test/fixtures/Attacks.sol`,
`test/fixtures/Evil.sol`, compiled out of tree, `ATTACKS_OUT=<out dir>`) and proposes each against
three live sentinels; `ATTACKS_OUT=... node --test test/unit.test.mjs` also checks their selectors /
opcodes offline.

| Attack implementation | Vetoed by |
|---|---|
| EvilTransferFromImpl (transferFrom without allowance) | R3B |
| EvilSweep (stranger moves holders[0]'s balance) | R3B |
| TimeBombMintImpl (NUMBER), FlagMintImpl (STATICCALL+GAS), OriginMintImpl (ORIGIN) | R9 |
| ThreeArgMintImpl, Evil3ArgMint (3-arg mint) | R1 (wide probe) |
| EvilZeroSelMint / EvilZeroSelOwner (PUSH3 selectors) | R1 / R2 |
| V2Init / V2Init3 without init data (anyone can call the reinitializer) | R2 |
| add guardian / SetPausedImpl / v2 + init data | R7 / R7 (key actionHash) / R8 (key codehash+data) |
| /attach and broadcast checks | "replacement underpriced" counts as not delivered; text/plain /attach → 415, no ACAO; 41-selector impl → truncated → R6 |

anvil `-b 0.3` (8587, SSE 8741-8743, token owner = GuardedAdmin from Deploy.s.sol): all 15
proposals vetoed x3 with the expected rule, 29 blocks left each; four cards 0 wrong verdicts.
Backfill: sentinels stopped, EvilMint proposed, restarted with `LOOKBACK_BLOCKS=1 RESCAN_BLOCKS=1`:
the startup scan judged it and it ended Vetoed x3 before readyBlock.

`script/export-shared.sh` regenerates `shared/rules.json` (R1–R9 including R3B, with zh labels); the
sentinel recomputes every hash on start.

## Next steps

- Fork-simulation fallback: an anvil fork as a third simulation provider next to official and
  thirdweb.
- Four-stage commit state from monadNewHeads `commitState` for the finality display (finality uses
  the `finalized` tag on testnet and 2-block depth on anvil).
