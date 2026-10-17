**English** · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md)

# 十一秒 Eleven Seconds

> 给合约升级装一个 30 个区块的冷静期：升级生效前，3 个独立哨兵先在模拟器里把新合约当攻击者打一遍，违反不变量就链上否决。
> Monad 测试网实测：恶意升级提案后 4–7 个区块否决就落地（最快 1.25 秒，攻击者还要等 23–26 个区块），execute 回 `ProposalVetoed`；正常升级 30 个区块后照常生效。

**Eleven Seconds puts a 30-block cooldown in front of every contract upgrade, and uses that window to
attack-test the new implementation in a simulator before it can go live.** If a stranger can mint,
seize ownership, or skim transfers under the new code, any one of three independent sentinels vetoes
the proposal on chain.

Built at **Monad Blitz Shanghai, 2026-10-17**. Network: Monad testnet (chain id 10143).

---

## Live demo

**https://eleven-seconds.pages.dev** — the war room in read-only chain mode (`?mode=chain`). The browser
talks to Monad testnet directly (WS `monadNewHeads` + GuardedAdmin `logs`, falling back to cursor-based
`eth_getLogs`, ≤100 blocks per call) and shows the last 5 proposals with who vetoed in which block, blocks
left for the attacker, the veto cost from the receipt (`gasUsed × effectiveGasPrice`) and MonadVision links.
It does not propose anything: live proposals are triggered by the operator, and the AI report text stays on
the operator's machine (only its on-chain `reportHash` / `attachReason` tx is shown).
The war room speaks 简体中文, 繁體中文 and English (toolbar button, `L` key or `?lang=zh-CN|zh-TW|en`) and
adapts to phones and tablets with a stacked, scrollable layout; wide landscape screens keep the 16:9 stage.
Rebuild: `cd web && npm run build:cloud` (bundles `shared/` deployment, ABI and rule hashes), then
`npx -y wrangler@3 pages deploy dist --project-name eleven-seconds --branch main`.

**https://eleven-seconds-arena.pages.dev** — the Arena, where visitors fire the cards themselves. Pick
EvilMint, EvilOwner, EvilFee or the v2 upgrade: a Cloudflare Worker (one Durable Object, no public
hostname) proposes it on a separate set of testnet contracts, three independently keyed sentinel verdicts
simulate it with `eth_simulateV1` + `stateOverride` and veto on chain, and the engine calls `execute` when
the cooldown ends. One proposal is in flight at a time, each visitor gets one card every 45 s, with hourly
and daily caps. Checked from the public URL on 2026-10-17: each attack card was vetoed by 3/3 sentinels
3–4 blocks after the proposal and `execute` reverted with `ProposalVetoed`; v2 passed and executed.
Details and deploy steps: [arena/README.md](arena/README.md).

## The problem

Upgradeable proxies are the most dangerous button in a protocol. When the upgrade key leaks, the
attack is short: deploy a malicious implementation, upgrade the proxy, mint without limit. The usual
answer is a timelock, but a 48–72 hour delay also blocks emergency fixes, so many teams leave the
upgrade right on a single key. And a timelock only makes you wait. It does not check anything.

## How it works

1. **Propose.** `GuardedAdmin` becomes the owner of the existing OpenZeppelin `ProxyAdmin` (one
   `transferOwnership`, the proxy is not redeployed). Every upgrade is a proposal with
   `readyBlock = block.number + 30`.
2. **Attack-simulate.** Three sentinel processes see `Proposed` (WebSocket and 300 ms `eth_getLogs`
   polling, de-duplicated by id). Each sends one merged `eth_simulateV1` request with a
   `stateOverride` that swaps the proxy's ERC-1967 implementation slot to the new code, then runs
   baseline reads, a normal holder transfer, every selector found in the new bytecode called from a
   fresh stranger address with several argument sets, and the reads again.
3. **Judge by invariants**, not by reading source code (sentinels only need bytecode). The rules
   R1–R9 are listed under [Security model](#security-model).

4. **Veto.** Any violation, and the sentinel broadcasts a pre-sized `veto(id, ruleHash)` on three RPCs
   (local nonce, fixed gas limit, no gas estimation). `execute()` after the window reverts with
   `ProposalVetoed`. A clean upgrade simply executes when the 30 blocks are up.
5. **Explain.** A reporter turns the simulation diff into a short Chinese risk note for the human
   multisig and attaches `keccak256(text)` on chain with `attachReason`. The AI is not on the veto
   path.

The guard also locks itself: removing a sentinel or shortening the delay is itself a proposal that
waits 30 blocks and gets vetoed (R7). `breakGlass()` lets the owner or any guardian switch the proxy
to a pre-registered paused implementation immediately.

## Architecture

```
  owner key (assume leaked)                     approver key (strict mode)
        | proposeUpgrade(newImpl, data)                | approveCodehash(hash)
        v                                              v
 +--------------------- GuardedAdmin (owner of ProxyAdmin and of dBTC) ---------------------+
 |  Proposed --> 30-block cooldown --> execute() --> ProxyAdmin.upgradeAndCall(proxy, impl)  |
 |     ^  veto(id, ruleHash) from any guardian          breakGlass() --> PausedImpl          |
 +-----|------------------------------------------------------------------------------------+
       |                               | Proposed event (WS + 300 ms getLogs)
 +-----+------+   +------------+   +------------+
 | sentinel-1 |   | sentinel-2 |   | sentinel-3 |   independent processes, own key, own RPCs
 +-----+------+   +------------+   +------------+   SSE on :8701-8703
       |  eth_simulateV1 + stateOverride (impl slot -> newImpl)
       |  baseline reads -> holder transfer -> stranger probes -> reads -> rules R1-R9
       v
 reporter :8710   local Qwen (LM Studio) or rule template -> Chinese note -> attachReason(id, hash)
 driver   :8700   sends demo proposals, auto-executes when ready, reads version()
 web      :5173   war room: block counter, attacker vs sentinels, veto stages, cost per veto
```

## Security model

**Attacker.** Holds the owner key of `GuardedAdmin` (the key that proposes upgrades; assume it is
leaked), can deploy any bytecode without publishing source, and calls `execute` the moment a proposal
is ready. The attacker does not hold the guardian keys or the approver key.

**What we block.** Upgrades and changes to the guard itself wait 30 blocks. `GuardedAdmin` owns the
`ProxyAdmin` and, since block 71726096, also the token's own `Ownable`
([tx](https://testnet.monadexplorer.com/tx/0xc48a8d8229e33bf4e6f4aa7c71251a56b834aecd93f0b5ff61e7ea5f4b3497bb)),
so the leaked key can neither upgrade nor `mint` directly (both revert with
`OwnableUnauthorizedAccount`), and `GuardedAdmin` has no generic call path. During the cooldown any
one sentinel can veto by these rules:

| Rule | Invariant |
| --- | --- |
| R1 | a stranger's call cannot change `totalSupply` |
| R2 | a stranger's call cannot change `owner()` |
| R3 | a transfer of X moves exactly X; nobody else's balance changes |
| R3B | a stranger cannot move anyone else's funds (`transferFrom` without allowance, or any probe) |
| R4 | a normal transfer still succeeds (no bricking upgrade) |
| R5 | strict mode: the codehash must be pre-approved by a second key |
| R6 | simulation failed on both providers or timed out: fail closed |
| R7 | removing a guardian, shortening the delay, or replacing the pause implementation needs approval |
| R8 | an upgrade with init data needs an approved codehash |
| R9 | the new code adds no dangerous opcode the current implementation lacks (block/tx context, external call, create, selfdestruct), unless its codehash is approved |

## Why Monad

The same 30-block cooldown on different chains:

| Chain | Block time | 30 blocks |
| --- | --- | --- |
| Ethereum | ~12 s | ~6 minutes |
| BNB Chain | ~0.45 s | ~13.5 seconds |
| Monad testnet | ~0.30 s measured today, sub-second finality | ~9 seconds (pre-event probes: 0.31–0.36 s/block, 9.3–10.9 s; we say "about 10 seconds") |

BNB Chain can also run a seconds-scale cooldown. What Monad adds is finer granularity, finality in
under a second (a landed veto is final, not reorg-able), and a low cost per veto, which together make a
window short enough to leave on permanently.

## Testnet deployment (chain 10143)

From [`shared/deployments/10143.json`](shared/deployments/10143.json), deployed at block 71718143.
Verification is on the MonadVision Sourcify instance (`sourcify-api-monad.blockvision.org`).

| Contract | Address | Source |
| --- | --- | --- |
| GuardedAdmin | [`0x57a84DCaDB3C29aeF27Cd5d7f3A3Af2C27F25ef4`](https://testnet.monadexplorer.com/address/0x57a84DCaDB3C29aeF27Cd5d7f3A3Af2C27F25ef4) | Sourcify exact match |
| DemoBTC proxy (dBTC) | [`0xE851E12bb9987F40A5f605eb0c8008Dce6eEB3A8`](https://testnet.monadexplorer.com/address/0xE851E12bb9987F40A5f605eb0c8008Dce6eEB3A8) | OpenZeppelin TransparentUpgradeableProxy, not submitted; token owner = GuardedAdmin since block 71726096 (`tokenOwner` in the deployments file) |
| ProxyAdmin | [`0x446d8bCD6365421fAf2BA00e1912A7A695E2caEf`](https://testnet.monadexplorer.com/address/0x446d8bCD6365421fAf2BA00e1912A7A695E2caEf) | created by the proxy, owner = GuardedAdmin |
| DemoBTC v1 impl | [`0x05aB95D20800870939605Fb57fc12c09c2fC5547`](https://testnet.monadexplorer.com/address/0x05aB95D20800870939605Fb57fc12c09c2fC5547) | Sourcify exact match |
| DemoBTC v2 impl | [`0xFb68bF421c64ef5efBa05B16B8a8C64a3b1fE5BA`](https://testnet.monadexplorer.com/address/0xFb68bF421c64ef5efBa05B16B8a8C64a3b1fE5BA) | Sourcify exact match |
| PausedImpl | [`0xd04Ba153293d643C696f3076051A89422447d4EB`](https://testnet.monadexplorer.com/address/0xd04Ba153293d643C696f3076051A89422447d4EB) | breakGlass target |
| EvilMintImpl | [`0x074E2C925d2621479226d9A277e90AF2B724B8A2`](https://testnet.monadexplorer.com/address/0x074E2C925d2621479226d9A277e90AF2B724B8A2) | demo attack, deliberately unverified |
| EvilOwnerImpl | [`0x712Cc2780419a06f15fF3c7D1DA47C6Ee4875659`](https://testnet.monadexplorer.com/address/0x712Cc2780419a06f15fF3c7D1DA47C6Ee4875659) | demo attack, deliberately unverified |
| EvilFeeImpl | [`0x68E90762e9914328Af6A3eA3aA914471124aF1d1`](https://testnet.monadexplorer.com/address/0x68E90762e9914328Af6A3eA3aA914471124aF1d1) | demo attack, deliberately unverified |

The attack implementations are not verified on purpose: a real attacker does not publish source, and
the sentinels judge bytecode only. Guardians: `0x7ED9…EF3b`, `0xd662…6B68`, `0x94b5…98bE`
(full list in the deployments file).

The Arena runs on its own contracts so visitors' proposals never touch the stage deployment:
GuardedAdmin [`0x1d286Ef4D622EFD91FeDe3560fB4Cff0D4ff0c59`](https://testnet.monadexplorer.com/address/0x1d286Ef4D622EFD91FeDe3560fB4Cff0D4ff0c59),
DemoBTC proxy [`0x5E58083bA85add746592352D49d3Db8f4E5A1a95`](https://testnet.monadexplorer.com/address/0x5E58083bA85add746592352D49d3Db8f4E5A1a95),
deployed at block 71767314 (GuardedAdmin, DemoBTC v1 and v2 Sourcify exact match; full list in
[`shared/deployments/10143-arena.json`](shared/deployments/10143-arena.json)).

## Measured today on Monad testnet (venue network, 2026-10-17)

**Afternoon runs (proposals #3–#9)**

| # | Card | Proposed at block | First veto landed | `proposal_seen` to veto receipt | Outcome |
| --- | --- | --- | --- | --- | --- |
| 3 | EvilMint | 71723855 | +5 blocks | 1768 ms | 3/3 veto |
| 4 | EvilOwner | 71723873 | +5 blocks | 1740 ms | 3/3 veto |
| 5 | EvilFee | 71723893 | +16 blocks | 7.4 s | 3/3 veto |
| 6 | EvilFee | 71724344 | +6 blocks | 1969 ms | 3/3 veto |
| 7 | v2 | 71724368 | — | — | 3/3 pass; executed in block 71724402 after the 30-block cooldown ([tx](https://testnet.monadexplorer.com/tx/0x4b831ca82af42363bd56de34405a4d46ff87982c02c298d70af05430db9df121)) |
| 8 | EvilFee | 71724394 | **+4 blocks** | **1314 ms** (fastest sentinel 1252 ms) | 3/3 veto |
| 9 | EvilOwner | 71724850 | +6 blocks | — | 3/3 veto |

Every vetoed proposal's `execute` reverts with `ProposalVetoed`. Typical result: the veto lands 4–7
blocks after the proposal, leaving the attacker 23–26 blocks short of `readyBlock`; every veto landed
inside the cooldown.

Proposal #8 (EvilFee, rule R3) on chain:

| What | Transaction |
| --- | --- |
| Proposed, block 71724394 (ready at 71724424) | [`0x2b0585d04013a24d605461472a43dcb16afea520a9bea65f3d5be56415938a78`](https://testnet.monadexplorer.com/tx/0x2b0585d04013a24d605461472a43dcb16afea520a9bea65f3d5be56415938a78) |
| First `Vetoed`, block 71724398 (all three vetoes in this block) | [`0x7a96dd70cfb0aadadcaa231ac5bb3b8d7fd4b8025df1ea107e10ab025593f290`](https://testnet.monadexplorer.com/tx/0x7a96dd70cfb0aadadcaa231ac5bb3b8d7fd4b8025df1ea107e10ab025593f290) |
| `execute(8)`, block 71724427, reverted with `ProposalVetoed` | [`0x48ca61e05beee8ec16bab69f46738681159156d91a2adf3f0c7eb73c3a80160c`](https://testnet.monadexplorer.com/tx/0x48ca61e05beee8ec16bab69f46738681159156d91a2adf3f0c7eb73c3a80160c) |

**Cost of one veto.** gas limit = gas used = 123,112 (Monad charges the gas limit). At 102 gwei that
is ~0.01256 MON (proposals #1–#8); with the 10 gwei priority-fee floor added afterwards, 110 gwei,
~0.01354 MON (from #9).

**First round, cold connections (EvilMint, proposal #1)**

| What | Result |
| --- | --- |
| Proposed | block 71719034 ([tx](https://testnet.monadexplorer.com/tx/0x03d9d828f91bad755da8d19f5d37633558501eb98eb32e2386797ee79a5fdae8)), ready at 71719064 |
| Verdict | all 3 sentinels: veto, rule R1 (stranger `mint` changed `totalSupply`) |
| First veto landed | block 71719043 ([tx](https://testnet.monadexplorer.com/tx/0x165a1878e550b57ec85309313fe8841fc73de18dee48bc287b13f81773a318b9)): **9 blocks after the proposal, 21 blocks before the attacker could execute**; vetoes 2 and 3 in blocks 71719044 and 71719045 |
| `proposal_seen` to veto receipt | 2681 ms (other two sentinels: 3060 ms, 3556 ms) |
| Simulation time (`simMs`) | 2236 / 2573 / 2308 ms, of which the `eth_simulateV1` request itself was 1399 / 804 / 689 ms; most of the rest was cold connection setup |
| Cost of one veto | 123,112 gas at 102 gwei = ~0.0126 MON |
| Attacker's `execute(1)` | block 71719073, reverted with `ProposalVetoed` ([tx](https://testnet.monadexplorer.com/tx/0x21fe66f76256e6a385de8bcf113bf252ff907d0fa186893b0634933ac5def169)) |
| Risk note hash on chain | `attachReason` in block 71719050 ([tx](https://testnet.monadexplorer.com/tx/0x703284958ce96e1cf078e4d80b049717982bcb59364974cad212badf41c25211)) |

**Normal upgrade (v2, proposal #2)**

| What | Result |
| --- | --- |
| Proposed | block 71719341 ([tx](https://testnet.monadexplorer.com/tx/0x7d1e60ae02678762974382745838bffbc91ef26d691fa86f9bf2d8bb9e991c57)), ready at 71719371 |
| Verdict | all 3 sentinels: pass (1670 / 1682 / 2689 ms) |
| Executed | block 71719382, after the 30-block cooldown ([tx](https://testnet.monadexplorer.com/tx/0x21aa34ff8486469761492fd66594d2d928f352f54dbaaf007bb1f1f9e21a1939)); `version()` returns `"2"` |

**Network notes.** Block timestamps over blocks 71718143–71719382 give ~0.30 s per block. On the
venue network a new TLS connection took 1.3–1.7 s, while on a kept-alive connection a read took about
320 ms and `eth_simulateV1` about 400 ms, so the sentinels and the driver keep their connections warm
and fail over between providers. The driver reads through ankr plus the official RPC. Only
`testnet-rpc.monad.xyz` and `10143.rpc.thirdweb.com` serve `eth_simulateV1`; the sentinels use them
for simulation only and use the others for logs, heartbeats and broadcasting.

On a local anvil (`--network monad -b 0.3`), 5 rounds of 4 cards: 0 wrong verdicts, every veto landed
1 block after the proposal, `proposal_seen` to veto receipt 299–309 ms; with one sentinel killed the
other two still vetoed every attack (details in [`sentinel/NOTES.md`](sentinel/NOTES.md)).

## How to run

Requirements: Foundry, Node 22+. Install each package once with `npm install` in `sentinel/`,
`driver/`, `reporter/` and `web/`.

### Local (anvil)

```bash
anvil --network monad -b 0.3 --port 8545
RPC_URL=http://127.0.0.1:8545 script/deploy.sh      # writes shared/deployments/anvil.json
sh sentinel/run.sh anvil                            # 3 sentinels, SSE on 8701-8703
(cd driver && npm start)                            # DEPLOYMENT=anvil by default, port 8700
(cd reporter && npm start)                          # port 8710; LLM_DISABLE=1 for template-only
(cd web && npm run dev)                             # http://127.0.0.1:5173/?mode=replay
```

Local mode uses anvil's public test accounts only.

### Monad testnet (10143)

The contracts above are already deployed; to redeploy see `script/deploy.sh` (dry run by default,
`BROADCAST=1` to send). Keys are read at run time from files (one hex key per file) and never printed.

```bash
KEY_DIR=<key dir> sh sentinel/run.sh testnet        # sentinel1.key .. sentinel3.key
                                                    # DRY_RUN=1: judge and sign, never broadcast
(cd driver && DEPLOYMENT=10143 DRIVER_BROADCAST=1 KEY_DIR=<key dir> \
  RPC_URLS=https://rpc.ankr.com/monad_testnet,https://testnet-rpc.monad.xyz npm start)
(cd reporter && npm start)
(cd web && npm run dev)                             # http://127.0.0.1:5173/?mode=testnet
```

### Without a chain

```bash
node sentinel/fake-events.mjs                       # fake sentinel SSE (FAKE_DRIVER=1 FAKE_REPORTER=1 for 8700/8710)
(cd web && npm run dev)                             # http://127.0.0.1:5173/?mode=fake
```

### Tests

```bash
forge test                                          # 33 GuardedAdmin tests (cooldown, veto, guard self-locking, breakGlass, token ownership)
node --test sentinel/test/unit.test.mjs             # offline sentinel unit tests
(cd reporter && npm test)                           # fake sentinels + fake LLM, no chain
ROUNDS=5 node sentinel/test/e2e-anvil.mjs           # needs anvil + deploy + 3 running sentinels
```

## Repository layout

| Path | Contents |
| --- | --- |
| `src/GuardedAdmin.sol` | cooldown, guardian veto, approver registry, breakGlass; owner of the ProxyAdmin |
| `src/DemoBTC.sol`, `src/DemoBTCV2.sol`, `src/PausedImpl.sol` | demo token (dBTC, 8 decimals) v1/v2 and the pause implementation |
| `src/attack/` | EvilMintImpl (R1), EvilOwnerImpl (R2), EvilFeeImpl (R3): demo attack code |
| `test/GuardedAdmin.t.sol` | Foundry tests |
| `script/` | `Deploy.s.sol` + `deploy.sh` (one-shot deploy), `measure-gas.sh`, `export-shared.sh` |
| `sentinel/` | sentinel process: detection, merged simulation, rules R1–R9, veto signer, SSE ([NOTES](sentinel/NOTES.md)) |
| `reporter/` | risk-note writer: local LLM with template fallback, hash attached on chain ([README](reporter/README.md)) |
| `driver/` | demo driver for the war room: propose cards, auto-execute, approve codehash |
| `web/` | war room frontend (Vite + TypeScript + viem) |
| `arena/` | cloud Arena: engine Worker + Durable Object (`arena/worker`), Pages front end with a service binding (`arena/pages`) |
| `shared/` | ABIs, deployment addresses, gas limits, rule-hash table shared by all parts |
| `docs/` | `spec.md` (pre-event plain-text spec), `contracts-cheatsheet.md` (manual `cast` operations) |
| `slides/` | offline pitch deck (`slides/index.html`, arrow keys to navigate) |
| `submission/` | event submission metadata |
| `scripts/` | generic RPC and block-header probes, generic deploy/verify wrappers |
| `broadcast/` | Foundry broadcast record of the testnet deployment |

## Prepared before the event (boilerplate only)

Following the Blitz rule that only boilerplate and research/planning may be prepared in advance, the
first commit contains generic scaffolding and a plain-text spec. None of it is application logic.

| Item | Source |
| --- | --- |
| `foundry.toml`, `remappings.txt` | Foundry defaults plus Monad settings from the Monad docs (solc version, `evm_version`, `network = "monad"`, public testnet RPC list, Sourcify verifier URL) |
| `src/Counter.sol`, `test/Counter.t.sol`, `script/Counter.s.sol` | `forge init` template, kept only to prove the toolchain compiled; removed during the event |
| `lib/forge-std` v1.17.0, `lib/openzeppelin-contracts` v5.7.0, `lib/openzeppelin-contracts-upgradeable` v5.7.0 | upstream release tags, vendored |
| `web/` (initial version) | `create-vite` vanilla-ts template, a viem `defineChain` for Monad testnet with a multi-RPC fallback transport, and a blank page showing the current block |
| `scripts/rpc-health.sh`, `scripts/heads.mjs` | generic RPC health check and block-header probe (dev tools) |
| `scripts/deploy.sh`, `scripts/verify.sh` | generic `forge create` / `forge verify-contract --verifier sourcify` wrappers |
| `.gitignore`, `.env.example`, `LICENSE` | standard project metadata |
| `docs/spec.md` | plain-text spec, threat model and interface list written as planning; contains no code |

**All application logic was written during Monad Blitz Shanghai on 2026-10-17**: the contracts in
`src/`, the tests, the deploy script, the sentinel, reporter, driver, the war room UI, and these docs
and slides. The commit history shows everything added after the boilerplate commit.

## AI tools used

- **During the event:** Claude Code, run as several parallel agents (contracts, sentinel, war room,
  reporter, docs), wrote the code and documentation from `docs/spec.md`, with the author directing,
  reviewing, deploying and running the testnet demo.
- **Before the event:** Claude Code helped prepare the boilerplate and the planning spec listed above.
- **Inside the product:** the reporter writes its risk note with a local Qwen model through LM Studio
  when one is available, and otherwise with a rule-based template (marked as a template in the UI). The
  notes on today's testnet run were template notes up to proposal #33; from #34 on they are written by
  Qwen3.8-27B running locally in LM Studio (about 3–5 s per note). Either way the note only explains; the veto
  decision is made by the sentinels' invariant checks.

## Scope and next steps

Eleven Seconds protects the **upgrade path**: changes to a proxy's implementation, and changes to the
guard's own configuration (guardians, delay, pause implementation). Simulation catches the class of
upgrades where a stranger can change state; new block- and tx-context opcodes are flagged by R9, and
upgrades whose behaviour depends on a specific caller are what strict mode (R5) is for. The three
sentinels are independent processes with separate keys.

Next steps:

1. **Strict mode by default**: every new codehash needs pre-approval by a second key (R5 is already
   implemented behind `STRICT=1`).
2. **Bonded sentinel network**: anyone can run a sentinel by posting a bond, so the guard does not
   depend on one operator's machines.
3. **Multisig override**: a delayed, multisig-approved path to override a veto.
4. Put other privileged roles (for example minters) behind the same cooldown.
5. **Proposal expiry and `cancel()`**: pending proposals time out, and the owner or a guardian can
   cancel one.
6. **breakGlass clears the queue**: switching to the paused implementation also cancels queued
   upgrades.

## License

MIT, see [LICENSE](LICENSE). Author: Ted Chen.
