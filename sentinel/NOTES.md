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
| `RPC_URL` | `127.0.0.1:8545` / `rpc-testnet.monadinfra.com` | getLogs polling, heartbeat, eth_call, receipts |
| `SIM_RPCS` | `RPC_URL` / official,thirdweb | eth_simulateV1 only; primary rotates by index, the other is the retry |
| `BROADCAST_RPCS` | `RPC_URL` / official,monadinfra,ankr | first uses eth_sendRawTransactionSync |
| `WS_URL` | ws form of RPC_URL / per process in run.sh | logs + heads subscription |
| `WS_LOGS_KIND`, `WS_HEADS_KIND` | `logs`,`newHeads` / `monadLogs`,`monadNewHeads` | |
| `POLL_MS`, `POLL_OFFSET_MS` | 300, (index-1)*100 | getLogs poll period and stagger |
| `GETLOGS_MAX_RANGE`, `LOOKBACK_BLOCKS` | 100, 60 | cursor = last processed + 1, at most 100 blocks per request |
| `HEARTBEAT_MS` | 500 | |
| `SIM_TIMEOUT_MS`, `SIM_BUDGET_MS` | 2500, 5000 | per request / total including the one retry (R6) |
| `SIM_CALL_GAS`, `SIM_READ_GAS`, `SIM_MAX_CALLS` | 300000, 100000, 150 | explicit gas on every simulated call |
| `SIM_KEEPALIVE_MS` | 0 / 5000 | eth_chainId ping that keeps the simulation sockets warm |
| `FINALITY` | `depth:2` / `tag` | `tag` = `eth_getBlockByNumber("finalized")` |
| `FEE_REFRESH_MS` | 10000 | |
| `GAS_HEADROOM` | 1.25 | multiplier on gas.json limits (see "Findings") |
| `STRICT`, `DRY_RUN`, `ATTACH` | 0, 0, 1 on sentinel-1 only | |

Ports: SSE `127.0.0.1:870{1,2,3}` with `GET /events` (`?backlog=N` replays the last N events,
default 0), `GET /health`, and `POST /attach {"id":N,"reportHash":"0x.."}` on sentinel-1 only.

## Judging

- Upgrade (kind 0): R5 (STRICT and codehash not approved) and R8 (non-empty data and codehash not
  approved) are decided without simulating. Otherwise one merged `eth_simulateV1` request, one block:
  baseline reads → `holders[0]` transfers 1% of its balance to a fresh address → reads → every selector
  found in the new bytecode × 4 argument sets (none / stranger / stranger+2^128 / 2^128) from a fresh
  stranger → reads. 73 calls for the demo impls. The request never contains a `validation` field.
- When several invariants break, the reported rule is the first of R4, R3, R2, R1 (so EvilOwner,
  whose `claimOwner` also unlocks `mint`, reports R2).
- Config proposals (kinds 1-3) are R7 when they weaken the guard: removing a guardian, lowering the
  delay, any SetPausedImpl. Approval key: the proposal's `codehash` if non-zero (SetPausedImpl), else
  `keccak256(abi.encode(uint8 kind, address target, uint256 value))`, looked up with
  `isApprovedCodehash`. This is a sentinel-side convention; the contract interface is unchanged.
- The current implementation is read from the ERC-1967 slot (derived exactly as OZ defines it,
  checked against `ERC1967Utils.sol` in the unit test) to compute `selectorsAdded`.

## SSE details beyond spec 4.4 (all extra data lives in `extra`)

- Amounts in wei / token units are decimal strings (`effectiveGasPrice`, `checks[].before/after`);
  blocks, gas, ms are numbers.
- `sim_result.extra`: `culprits` (probe selector + args whose logs show a mint/burn or ownership move),
  `skimmedTo` (watchlist addresses that received value during the plain transfer), `selectorsRemoved`,
  `probes`, `calls`, `simRpc`, `simRequestMs`, `retried`, `errors` (R6).
- `veto_sent` is emitted when the raw tx goes out, before any RPC answers; `veto_receipt.extra` has
  `vetoBlocksAfterPropose` and `blocksLeftForAttacker`.
- `reason_attached` is emitted once the attachReason tx has been accepted.

## Measurements

| What | Result |
|---|---|
| eth_simulateV1, official, 20-call request, kept-alive (2026-10-17 11:38 UTC+8, operator's network) | 314–355 ms; connection setup + first call 1098 ms |
| same, thirdweb | 367–450 ms; setup 1156 ms; no 429 in 6 sequential requests |
| R6 timeouts | kept at 2500 ms per request / 5000 ms budget: about 6x the kept-alive latency, and a retry still fits |
| anvil `--network monad -b 0.3`, 3 sentinels, 5 rounds × 4 cards (evilMint, evilOwner, evilFee, v2) | 0 wrong verdicts; every veto landed 1 block after the proposal (29 blocks left); proposal_seen → veto_receipt 299–309 ms; vetoed execute → `ProposalVetoed`; v2 executes after 30 blocks, `version()` = "2" |
| kill sentinel-2 after round 3 (SIGKILL) | its heartbeats stop immediately; rounds 4–5 vetoed by the other two (vetoCount 2), 0 failures |
| dedupe | every proposal arrived on both WS and polling (20 duplicates dropped per sentinel in 20 proposals); one proposal_seen and at most one veto per sentinel |
| R7 / R8 on anvil | remove guardian → R7, add guardian → pass, delay 30→10 → R7, 30→40 → pass, upgrade with init data → R8 |

Testnet numbers (proposal_seen → veto_receipt, veto block, gas cost) are not measured yet: they
need the 10143 deployment and a testnet broadcast started by the operator.

## Findings

- **gas.json veto limit is too tight.** On anvil `--network monad` a first veto used 89,535 gas early
  in the run and 100,335 later (four cold SLOADs at 8,100 each), above gas.json's 98,489
  (89,535 × 1.10): so the sentinel
  multiplies gas.json limits by `GAS_HEADROOM` (default 1.25 → 123,112). Monad charges the gas
  limit, so a veto costs up to 25% more than with the tight limit.

## Next steps

- Fork-simulation fallback (anvil fork when both testnet simulation RPCs are down): not implemented;
  today that case is an R6 fail-closed veto.
- Four-stage commit state (monadNewHeads `commitState`): finality uses the `finalized` block tag
  (testnet) or 2-block depth (anvil); heads are used only for `lastBlock`.
- Not run against testnet (no 10143 deployment yet; no testnet broadcasts from this line).
