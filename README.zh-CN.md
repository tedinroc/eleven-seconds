[English](README.md) · **简体中文** · [繁體中文](README.zh-TW.md)

# 十一秒 Eleven Seconds

> 给合约升级装一个 30 个区块的冷静期：升级生效前，3 个独立哨兵先在模拟器里把新合约当攻击者打一遍，违反不变量就链上否决。
> Monad 测试网实测：恶意升级提案后 4–7 个区块否决就落地（最快 1.25 秒，攻击者还要等 23–26 个区块），execute 回 `ProposalVetoed`；正常升级 30 个区块后照常生效。

**十一秒（Eleven Seconds）在每一次合约升级之前加上 30 个区块的冷静期，并利用这段窗口，在新实现上线之前先在模拟器里对它做攻击测试。**
如果在新代码下陌生地址能够增发、夺取所有权或从转账中抽成，三个独立哨兵中的任意一个都会在链上否决该提案。

于 **Monad Blitz Shanghai，2026-10-17** 期间开发。网络：Monad 测试网（chain id 10143）。

---

## 在线演示

**https://eleven-seconds.pages.dev** — 链上只读模式（`?mode=chain`）的战情室。浏览器直接与 Monad 测试网通信
（WS `monadNewHeads` + GuardedAdmin `logs`，可回退到基于游标的 `eth_getLogs`，每次调用 ≤100 个区块），并显示最近 5 个提案：
谁在哪个区块否决、攻击者还要等多少个区块、从收据算出的否决成本（`gasUsed × effectiveGasPrice`）以及 MonadVision 链接。
它不会发起任何提案：现场提案由操作者触发，AI 报告的文本留在操作者本机（页面只显示它在链上的 `reportHash` / `attachReason` 交易）。
战情室支持简体中文、繁体中文和英文（工具栏按钮、`L` 键或 `?lang=zh-CN|zh-TW|en`），在手机和平板上改用纵向堆叠、可滚动的布局；
横向宽屏则保留 16:9 舞台。
重新构建：`cd web && npm run build:cloud`（打包 `shared/` 中的部署信息、ABI 和规则哈希），然后
`npx -y wrangler@3 pages deploy dist --project-name eleven-seconds --branch main`。

**https://eleven-seconds-arena.pages.dev** — 云端互动版（Arena），访客可以亲手打出卡牌。选择
EvilMint、EvilOwner、EvilFee 或 v2 升级：一个 Cloudflare Worker（一个 Durable Object，无公开主机名）
在另一套独立的测试网合约上发起提案，三个各自持有独立钥匙的哨兵判定用 `eth_simulateV1` + `stateOverride`
进行模拟并在链上否决，冷静期结束时由引擎调用 `execute`。同一时间只有一个提案在处理中，每位访客每 45 s 可以打一张牌，
并设有每小时和每日上限。2026-10-17 从公开网址检查：每张攻击卡都在提案后 3–4 个区块被 3/3 哨兵否决，
`execute` 以 `ProposalVetoed` 回滚；v2 放行并已执行。
详情与部署步骤：[arena/README.md](arena/README.md)。

## 问题

可升级代理是协议里最危险的按钮。一旦升级钥匙泄露，攻击过程很短：部署恶意实现、升级代理、无限增发。
常见的对策是时间锁（timelock），但 48–72 小时的延迟同样会挡住紧急修复，所以很多团队把升级权限留在单一钥匙上。
而且时间锁只会让你等待，它什么都不检查。

## 工作原理

1. **提案。** `GuardedAdmin` 成为现有 OpenZeppelin `ProxyAdmin` 的 owner（一次
   `transferOwnership`，代理不重新部署）。每次升级都是一个提案，其
   `readyBlock = block.number + 30`。
2. **攻击模拟。** 三个哨兵进程看到 `Proposed`（WebSocket 加 300 ms `eth_getLogs`
   轮询，按 id 去重）。每个哨兵发送一个合并的 `eth_simulateV1` 请求，带上一个
   `stateOverride`，把代理的 ERC-1967 实现槽换成新代码，然后依次执行：基线读取、一次正常的持有者转账、
   用一个全新的陌生地址以多组参数调用新 bytecode 中找到的每一个 selector，最后再读取一次。
3. **按不变量判定**，而不是读源代码（哨兵只需要 bytecode）。规则
   R1–R9 列在[安全模型](#security-model)一节。

4. **否决。** 只要有任何违规，哨兵就在三个 RPC 上广播一笔预先定好规格的 `veto(id, ruleHash)`
   （本地 nonce、固定 gas limit、不做 gas 估算）。窗口期过后调用 `execute()` 会以
   `ProposalVetoed` 回滚。干净的升级在 30 个区块期满后直接执行。
5. **解释。** reporter 把模拟差异转写成一份简短的中文风险报告，供人工多签参考，
   并通过 `attachReason` 把 `keccak256(text)` 附到链上。AI 不在否决
   路径上。

守门合约也会锁住自身：移除哨兵或缩短延迟本身就是一个提案，同样要等 30 个区块，并会被否决（R7）。
`breakGlass()` 允许 owner 或任一 guardian 立即把代理切换到预先登记的暂停实现。

## 架构

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

<a id="security-model"></a>

## 安全模型

**攻击者。** 持有 `GuardedAdmin` 的 owner 钥匙（用来提案升级的钥匙；假设它已经泄露），
可以部署任意 bytecode 而不公开源代码，并在提案一到可执行时就立刻调用 `execute`。
攻击者不持有 guardian 钥匙，也不持有 approver 钥匙。

**我们拦截什么。** 升级以及对守门合约自身的变更都要等 30 个区块。`GuardedAdmin` 拥有
`ProxyAdmin`，并且自区块 71726096 起也拥有代币自身的 `Ownable`
（[交易](https://testnet.monadexplorer.com/tx/0xc48a8d8229e33bf4e6f4aa7c71251a56b834aecd93f0b5ff61e7ea5f4b3497bb)），
因此泄露的钥匙既不能直接升级，也不能直接 `mint`（两者都会以
`OwnableUnauthorizedAccount` 回滚），而 `GuardedAdmin` 也没有通用的调用路径。冷静期内，
任意一个哨兵都可以按以下规则否决：

| 规则 | 不变量 |
| --- | --- |
| R1 | 陌生地址的调用不能改变 `totalSupply` |
| R2 | 陌生地址的调用不能改变 `owner()` |
| R3 | 转账 X 就恰好转移 X；其他任何人的余额都不变 |
| R3B | 陌生地址不能挪动别人的资金（没有授权额度的 `transferFrom`，或任何探测调用） |
| R4 | 正常转账仍然成功（不能是把合约变成砖头的升级） |
| R5 | 严格模式：codehash 必须事先由第二把钥匙核准 |
| R6 | 两个服务商上的模拟都失败或超时：fail-closed 否决 |
| R7 | 移除 guardian、缩短延迟或替换暂停实现都需要核准 |
| R8 | 带初始化数据的升级需要已核准的 codehash |
| R9 | 新代码不新增当前实现没有的危险 opcode（区块/交易上下文、外部调用、create、selfdestruct），除非其 codehash 已核准 |

## 为什么选 Monad

同样 30 个区块的冷静期，放在不同的链上：

| 链 | 出块时间 | 30 个区块 |
| --- | --- | --- |
| 以太坊 | ~12 s | 约 6 分钟 |
| BNB Chain | ~0.45 s | 约 13.5 秒 |
| Monad 测试网 | 今天实测 ~0.30 s，亚秒级终局 | 约 9 秒（赛前探测：0.31–0.36 s/区块，9.3–10.9 s；我们的说法是“约 10 秒”） |

BNB Chain 也能跑秒级的冷静期。Monad 额外带来的是更细的粒度、一秒内终局（已落地的否决就是最终结果，
不会被重组），以及很低的单次否决成本，三者结合，使这个窗口短到可以永久开着。

## 测试网部署（链 10143）

数据来自 [`shared/deployments/10143.json`](shared/deployments/10143.json)，部署于区块 71718143。
合约验证在 MonadVision 的 Sourcify 实例（`sourcify-api-monad.blockvision.org`）上进行。

| 合约 | 地址 | 源代码 |
| --- | --- | --- |
| GuardedAdmin | [`0x57a84DCaDB3C29aeF27Cd5d7f3A3Af2C27F25ef4`](https://testnet.monadexplorer.com/address/0x57a84DCaDB3C29aeF27Cd5d7f3A3Af2C27F25ef4) | Sourcify 完全匹配 |
| DemoBTC 代理（dBTC） | [`0xE851E12bb9987F40A5f605eb0c8008Dce6eEB3A8`](https://testnet.monadexplorer.com/address/0xE851E12bb9987F40A5f605eb0c8008Dce6eEB3A8) | OpenZeppelin TransparentUpgradeableProxy，未提交验证；自区块 71726096 起代币 owner = GuardedAdmin（部署文件中的 `tokenOwner`） |
| ProxyAdmin | [`0x446d8bCD6365421fAf2BA00e1912A7A695E2caEf`](https://testnet.monadexplorer.com/address/0x446d8bCD6365421fAf2BA00e1912A7A695E2caEf) | 由代理创建，owner = GuardedAdmin |
| DemoBTC v1 实现 | [`0x05aB95D20800870939605Fb57fc12c09c2fC5547`](https://testnet.monadexplorer.com/address/0x05aB95D20800870939605Fb57fc12c09c2fC5547) | Sourcify 完全匹配 |
| DemoBTC v2 实现 | [`0xFb68bF421c64ef5efBa05B16B8a8C64a3b1fE5BA`](https://testnet.monadexplorer.com/address/0xFb68bF421c64ef5efBa05B16B8a8C64a3b1fE5BA) | Sourcify 完全匹配 |
| PausedImpl | [`0xd04Ba153293d643C696f3076051A89422447d4EB`](https://testnet.monadexplorer.com/address/0xd04Ba153293d643C696f3076051A89422447d4EB) | breakGlass 的目标 |
| EvilMintImpl | [`0x074E2C925d2621479226d9A277e90AF2B724B8A2`](https://testnet.monadexplorer.com/address/0x074E2C925d2621479226d9A277e90AF2B724B8A2) | 演示用攻击，刻意不验证 |
| EvilOwnerImpl | [`0x712Cc2780419a06f15fF3c7D1DA47C6Ee4875659`](https://testnet.monadexplorer.com/address/0x712Cc2780419a06f15fF3c7D1DA47C6Ee4875659) | 演示用攻击，刻意不验证 |
| EvilFeeImpl | [`0x68E90762e9914328Af6A3eA3aA914471124aF1d1`](https://testnet.monadexplorer.com/address/0x68E90762e9914328Af6A3eA3aA914471124aF1d1) | 演示用攻击，刻意不验证 |

攻击实现刻意不做验证：真正的攻击者不会公开源代码，而哨兵只按 bytecode 判定。Guardian：`0x7ED9…EF3b`、`0xd662…6B68`、`0x94b5…98bE`
（完整列表见部署文件）。

云端互动版（Arena）使用自己的一套合约，访客的提案绝不会碰到现场演示用的部署：
GuardedAdmin [`0x1d286Ef4D622EFD91FeDe3560fB4Cff0D4ff0c59`](https://testnet.monadexplorer.com/address/0x1d286Ef4D622EFD91FeDe3560fB4Cff0D4ff0c59)，
DemoBTC 代理 [`0x5E58083bA85add746592352D49d3Db8f4E5A1a95`](https://testnet.monadexplorer.com/address/0x5E58083bA85add746592352D49d3Db8f4E5A1a95)，
部署于区块 71767314（GuardedAdmin、DemoBTC v1 和 v2 均为 Sourcify 完全匹配；完整列表见
[`shared/deployments/10143-arena.json`](shared/deployments/10143-arena.json)）。

## 今天在 Monad 测试网上的实测（会场网络，2026-10-17）

**下午的几轮（提案 #3–#9）**

| # | 卡牌 | 提案区块 | 首个否决落地 | `proposal_seen` 到否决收据 | 结果 |
| --- | --- | --- | --- | --- | --- |
| 3 | EvilMint | 71723855 | +5 个区块 | 1768 ms | 3/3 否决 |
| 4 | EvilOwner | 71723873 | +5 个区块 | 1740 ms | 3/3 否决 |
| 5 | EvilFee | 71723893 | +16 个区块 | 7.4 s | 3/3 否决 |
| 6 | EvilFee | 71724344 | +6 个区块 | 1969 ms | 3/3 否决 |
| 7 | v2 | 71724368 | — | — | 3/3 放行；30 个区块冷静期后在区块 71724402 执行（[交易](https://testnet.monadexplorer.com/tx/0x4b831ca82af42363bd56de34405a4d46ff87982c02c298d70af05430db9df121)） |
| 8 | EvilFee | 71724394 | **+4 个区块** | **1314 ms**（最快的哨兵 1252 ms） | 3/3 否决 |
| 9 | EvilOwner | 71724850 | +6 个区块 | — | 3/3 否决 |

每个被否决提案的 `execute` 都以 `ProposalVetoed` 回滚。典型结果：否决在提案后 4–7
个区块落地，攻击者距离 `readyBlock` 还差 23–26 个区块；每一次否决都落在
冷静期之内。

提案 #8（EvilFee，规则 R3）的链上记录：

| 内容 | 交易 |
| --- | --- |
| 提案，区块 71724394（71724424 可执行） | [`0x2b0585d04013a24d605461472a43dcb16afea520a9bea65f3d5be56415938a78`](https://testnet.monadexplorer.com/tx/0x2b0585d04013a24d605461472a43dcb16afea520a9bea65f3d5be56415938a78) |
| 首个 `Vetoed`，区块 71724398（三个否决都在这个区块） | [`0x7a96dd70cfb0aadadcaa231ac5bb3b8d7fd4b8025df1ea107e10ab025593f290`](https://testnet.monadexplorer.com/tx/0x7a96dd70cfb0aadadcaa231ac5bb3b8d7fd4b8025df1ea107e10ab025593f290) |
| `execute(8)`，区块 71724427，以 `ProposalVetoed` 回滚 | [`0x48ca61e05beee8ec16bab69f46738681159156d91a2adf3f0c7eb73c3a80160c`](https://testnet.monadexplorer.com/tx/0x48ca61e05beee8ec16bab69f46738681159156d91a2adf3f0c7eb73c3a80160c) |

**单次否决成本。** gas limit = gas used = 123,112（Monad 按 gas limit 收费）。按 102 gwei 计算，
即 ~0.01256 MON（提案 #1–#8）；之后加上 10 gwei 的优先费下限，为 110 gwei，
~0.01354 MON（从 #9 起）。

**第一轮，冷连接（EvilMint，提案 #1）**

| 内容 | 结果 |
| --- | --- |
| 提案 | 区块 71719034（[交易](https://testnet.monadexplorer.com/tx/0x03d9d828f91bad755da8d19f5d37633558501eb98eb32e2386797ee79a5fdae8)），71719064 可执行 |
| 判定 | 3 个哨兵全部：否决，规则 R1（陌生地址 `mint` 改变了 `totalSupply`） |
| 首个否决落地 | 区块 71719043（[交易](https://testnet.monadexplorer.com/tx/0x165a1878e550b57ec85309313fe8841fc73de18dee48bc287b13f81773a318b9)）：**提案后 9 个区块，距攻击者能执行还有 21 个区块**；第 2、3 个否决分别在区块 71719044 和 71719045 |
| `proposal_seen` 到否决收据 | 2681 ms（另外两个哨兵：3060 ms、3556 ms） |
| 模拟耗时（`simMs`） | 2236 / 2573 / 2308 ms，其中 `eth_simulateV1` 请求本身为 1399 / 804 / 689 ms；其余大部分是建立冷连接的时间 |
| 单次否决成本 | 123,112 gas，按 102 gwei 计 = ~0.0126 MON |
| 攻击者的 `execute(1)` | 区块 71719073，以 `ProposalVetoed` 回滚（[交易](https://testnet.monadexplorer.com/tx/0x21fe66f76256e6a385de8bcf113bf252ff907d0fa186893b0634933ac5def169)） |
| 链上的风险报告哈希 | 区块 71719050 中的 `attachReason`（[交易](https://testnet.monadexplorer.com/tx/0x703284958ce96e1cf078e4d80b049717982bcb59364974cad212badf41c25211)） |

**正常升级（v2，提案 #2）**

| 内容 | 结果 |
| --- | --- |
| 提案 | 区块 71719341（[交易](https://testnet.monadexplorer.com/tx/0x7d1e60ae02678762974382745838bffbc91ef26d691fa86f9bf2d8bb9e991c57)），71719371 可执行 |
| 判定 | 3 个哨兵全部：放行（1670 / 1682 / 2689 ms） |
| 已执行 | 区块 71719382，在 30 个区块冷静期之后（[交易](https://testnet.monadexplorer.com/tx/0x21aa34ff8486469761492fd66594d2d928f352f54dbaaf007bb1f1f9e21a1939)）；`version()` 返回 `"2"` |

**网络说明。** 根据区块 71718143–71719382 的区块时间戳，得出每个区块 ~0.30 s。在
会场网络上，新建一条 TLS 连接需要 1.3–1.7 s，而在保持连接（keep-alive）的连接上，一次读取约
320 ms，`eth_simulateV1` 约 400 ms，因此哨兵和 driver 会让连接保持预热，
并在服务商之间故障切换。driver 通过 ankr 加官方 RPC 读取。只有
`testnet-rpc.monad.xyz` 和 `10143.rpc.thirdweb.com` 提供 `eth_simulateV1`；哨兵只用它们
做模拟，日志、心跳和广播则使用其他 RPC。

在本地 anvil（`--network monad -b 0.3`）上，4 张卡跑 5 轮：0 次误判，每个否决都在
提案后 1 个区块落地，`proposal_seen` 到否决收据 299–309 ms；关掉一个哨兵后，
其余两个仍然否决了每一次攻击（详见 [`sentinel/NOTES.md`](sentinel/NOTES.md)）。

## 如何运行

环境要求：Foundry、Node 22+。在 `sentinel/`、
`driver/`、`reporter/` 和 `web/` 中各运行一次 `npm install` 安装依赖。

### 本地（anvil）

```bash
anvil --network monad -b 0.3 --port 8545
RPC_URL=http://127.0.0.1:8545 script/deploy.sh      # writes shared/deployments/anvil.json
sh sentinel/run.sh anvil                            # 3 sentinels, SSE on 8701-8703
(cd driver && npm start)                            # DEPLOYMENT=anvil by default, port 8700
(cd reporter && npm start)                          # port 8710; LLM_DISABLE=1 for template-only
(cd web && npm run dev)                             # http://127.0.0.1:5173/?mode=replay
```

本地模式只使用 anvil 公开的测试账户。

### Monad 测试网（10143）

上述合约已经部署；如需重新部署，请看 `script/deploy.sh`（默认为试运行，
设 `BROADCAST=1` 才会发送）。钥匙在运行时从文件读取（每个文件一把十六进制钥匙），绝不打印出来。

```bash
KEY_DIR=<key dir> sh sentinel/run.sh testnet        # sentinel1.key .. sentinel3.key
                                                    # DRY_RUN=1: judge and sign, never broadcast
(cd driver && DEPLOYMENT=10143 DRIVER_BROADCAST=1 KEY_DIR=<key dir> \
  RPC_URLS=https://rpc.ankr.com/monad_testnet,https://testnet-rpc.monad.xyz npm start)
(cd reporter && npm start)
(cd web && npm run dev)                             # http://127.0.0.1:5173/?mode=testnet
```

### 不连链

```bash
node sentinel/fake-events.mjs                       # fake sentinel SSE (FAKE_DRIVER=1 FAKE_REPORTER=1 for 8700/8710)
(cd web && npm run dev)                             # http://127.0.0.1:5173/?mode=fake
```

### 测试

```bash
forge test                                          # 33 GuardedAdmin tests (cooldown, veto, guard self-locking, breakGlass, token ownership)
node --test sentinel/test/unit.test.mjs             # offline sentinel unit tests
(cd reporter && npm test)                           # fake sentinels + fake LLM, no chain
ROUNDS=5 node sentinel/test/e2e-anvil.mjs           # needs anvil + deploy + 3 running sentinels
```

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `src/GuardedAdmin.sol` | 冷静期、guardian 否决、approver 登记表、breakGlass；ProxyAdmin 的 owner |
| `src/DemoBTC.sol`、`src/DemoBTCV2.sol`、`src/PausedImpl.sol` | 演示代币（dBTC，8 位小数）v1/v2 以及暂停实现 |
| `src/attack/` | EvilMintImpl（R1）、EvilOwnerImpl（R2）、EvilFeeImpl（R3）：演示用攻击代码 |
| `test/GuardedAdmin.t.sol` | Foundry 测试 |
| `script/` | `Deploy.s.sol` + `deploy.sh`（一键部署）、`measure-gas.sh`、`export-shared.sh` |
| `sentinel/` | 哨兵进程：检测、合并模拟、规则 R1–R9、否决签名器、SSE（[NOTES](sentinel/NOTES.md)） |
| `reporter/` | 风险报告撰写程序：本地 LLM，模板兜底，哈希附到链上（[README](reporter/README.md)） |
| `driver/` | 战情室的演示 driver：发起卡牌提案、自动执行、核准 codehash |
| `web/` | 战情室前端（Vite + TypeScript + viem） |
| `arena/` | 云端互动版（Arena）：引擎 Worker + Durable Object（`arena/worker`），带 service binding 的 Pages 前端（`arena/pages`） |
| `shared/` | 各部分共用的 ABI、部署地址、gas limit、规则哈希表 |
| `docs/` | `spec.md`（赛前的纯文本规格）、`contracts-cheatsheet.md`（手动 `cast` 操作） |
| `slides/` | 离线路演幻灯片（`slides/index.html`，用方向键翻页） |
| `submission/` | 比赛提交元数据 |
| `scripts/` | 通用 RPC 与区块头探测、通用部署/验证封装脚本 |
| `broadcast/` | 测试网部署的 Foundry broadcast 记录 |

## 赛前准备（仅样板代码）

按照 Blitz 只允许提前准备样板代码和研究/规划的规则，
第一个 commit 包含通用脚手架和一份纯文本规格。其中没有任何应用逻辑。

| 项目 | 来源 |
| --- | --- |
| `foundry.toml`、`remappings.txt` | Foundry 默认值，加上 Monad 文档中的 Monad 设置（solc 版本、`evm_version`、`network = "monad"`、公开测试网 RPC 列表、Sourcify 验证器 URL） |
| `src/Counter.sol`、`test/Counter.t.sol`、`script/Counter.s.sol` | `forge init` 模板，只用来证明工具链能编译；比赛期间已删除 |
| `lib/forge-std` v1.17.0、`lib/openzeppelin-contracts` v5.7.0、`lib/openzeppelin-contracts-upgradeable` v5.7.0 | 上游发布标签，直接纳入仓库（vendored） |
| `web/`（初始版本） | `create-vite` vanilla-ts 模板、一个带多 RPC 回退 transport 的 Monad 测试网 viem `defineChain`，以及一个显示当前区块的空白页面 |
| `scripts/rpc-health.sh`、`scripts/heads.mjs` | 通用 RPC 健康检查和区块头探测（开发工具） |
| `scripts/deploy.sh`、`scripts/verify.sh` | 通用 `forge create` / `forge verify-contract --verifier sourcify` 封装脚本 |
| `.gitignore`、`.env.example`、`LICENSE` | 标准项目元数据 |
| `docs/spec.md` | 作为规划撰写的纯文本规格、威胁模型和接口列表；不含代码 |

**所有应用逻辑都是 2026-10-17 在 Monad Blitz Shanghai 期间编写的**：`src/` 中的合约、
测试、部署脚本、哨兵、reporter、driver、战情室 UI，以及这些文档
和幻灯片。commit 历史显示了样板代码 commit 之后添加的所有内容。

## 使用的 AI 工具

- **比赛期间：** Claude Code 以多个并行 agent 运行（合约、哨兵、战情室、
  reporter、文档），根据 `docs/spec.md` 编写代码和文档，作者负责指挥、
  审查、部署并运行测试网演示。
- **赛前：** Claude Code 协助准备了上面列出的样板代码和规划规格。
- **产品内部：** 有本地 Qwen 模型可用时，reporter 通过 LM Studio 用它撰写风险报告，
  否则使用基于规则的模板（在 UI 中标注为模板）。今天测试网上提案 #33 及之前的
  报告是模板报告，#34 起由 LM Studio 本地运行的 Qwen3.8-27B 撰写（每份约 3–5 秒）。无论哪种方式，报告都只负责解释；否决
  决定由哨兵的不变量检查做出。

## 范围与下一步

十一秒保护的是**升级路径**：代理实现的变更，以及
守门合约自身配置的变更（guardian、延迟、暂停实现）。模拟能抓到陌生地址可以改变状态的那一类
升级；新增的区块和交易上下文 opcode 会被 R9 标记，而行为取决于特定调用者的
升级，正是严格模式（R5）要处理的。三个
哨兵是使用各自独立钥匙的独立进程。

下一步：

1. **默认启用严格模式**：每个新 codehash 都需要第二把钥匙事先核准（R5 已经
   实现，需设置 `STRICT=1` 开启）。
2. **质押式哨兵网络**：任何人质押保证金即可运行哨兵，这样守门合约就不
   依赖单一运营者的机器。
3. **多签推翻**：一条有延迟、经多签批准的路径，用来推翻否决。
4. 把其他特权角色（例如 minter）也放到同样的冷静期之后。
5. **提案过期与 `cancel()`**：待处理的提案会超时，owner 或 guardian 可以
   取消提案。
6. **breakGlass 清空队列**：切换到暂停实现时，同时取消排队中的
   升级。

## 许可证

MIT，见 [LICENSE](LICENSE)。作者：Ted Chen。
