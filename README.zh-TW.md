[English](README.md) · [简体中文](README.zh-CN.md) · **繁體中文**

# 十一秒 Eleven Seconds

> 給合約升級裝一個 30 個區塊的冷靜期：升級生效前，3 個獨立哨兵先在模擬器裡把新合約當攻擊者打一遍，違反不變量就鏈上否決。
> Monad 測試網實測：惡意升級提案後 4–7 個區塊否決就落地（最快 1.25 秒，攻擊者還要等 23–26 個區塊），execute 回 `ProposalVetoed`；正常升級 30 個區塊後照常生效。

**十一秒 Eleven Seconds 在每一次合約升級前面放一段 30 個區塊的冷靜期，並利用這段時間，在新實作生效之前先於模擬器裡對它做攻擊測試。** 如果在新程式碼下，陌生地址能夠 mint、奪取 owner，或從轉帳中偷抽成，三個獨立哨兵中的任何一個都會在鏈上否決這個提案。

於 **Monad Blitz Shanghai, 2026-10-17** 打造。網路：Monad 測試網（chain id 10143）。

---

## 線上展示

**https://eleven-seconds.pages.dev** — 鏈上唯讀模式的戰情室（`?mode=chain`）。瀏覽器直接連 Monad 測試網（WS `monadNewHeads` + GuardedAdmin `logs`，備援改用以游標推進的 `eth_getLogs`，每次呼叫 ≤100 個區塊），顯示最近 5 個提案：誰在哪個區塊否決、攻擊者還剩幾個區塊、從收據算出的否決成本（`gasUsed × effectiveGasPrice`），以及 MonadVision 連結。它不會送出任何提案：現場提案由操作者觸發，AI 報告全文留在操作者本機（只顯示它在鏈上的 `reportHash` / `attachReason` 交易）。戰情室支援簡體中文、繁體中文和 English（工具列按鈕、`L` 鍵或 `?lang=zh-CN|zh-TW|en`），並在手機與平板上改用上下堆疊、可捲動的版面；寬的橫向螢幕則維持 16:9 舞台。重新建置：`cd web && npm run build:cloud`（會把 `shared/` 的部署資料、ABI 和規則雜湊打包進去），然後 `npx -y wrangler@3 pages deploy dist --project-name eleven-seconds --branch main`。

**https://eleven-seconds-arena.pages.dev** — Arena 雲端互動版，訪客可以親手打出卡片。選擇 EvilMint、EvilOwner、EvilFee 或 v2 升級：一個 Cloudflare Worker（一個 Durable Object，沒有公開的主機名稱）會在另一組獨立的測試網合約上提案，三個各自持有金鑰的哨兵判定以 `eth_simulateV1` + `stateOverride` 模擬它，並在鏈上否決，冷靜期結束時由引擎呼叫 `execute`。同一時間只會有一個進行中的提案，每位訪客每 45 s 可以出一張卡，另有每小時與每日上限。2026-10-17 從公開網址實測：每張攻擊卡都在提案後 3–4 個區塊被 3/3 哨兵否決，`execute` 以 `ProposalVetoed` 回滾；v2 放行並已執行。細節與部署步驟：[arena/README.md](arena/README.md)。

## 問題

可升級代理合約是一個協議裡最危險的按鈕。升級金鑰一旦外洩，攻擊流程很短：部署惡意實作、升級代理合約、無上限 mint。常見的解法是時間鎖（timelock），但 48–72 小時的延遲也會擋住緊急修補，所以很多團隊把升級權留在單一金鑰上。而且時間鎖只會讓你等，它不檢查任何東西。

## 運作方式

1. **提案。** `GuardedAdmin` 成為既有 OpenZeppelin `ProxyAdmin` 的 owner（只需一次 `transferOwnership`，代理合約不用重新部署）。每一次升級都是一個提案，`readyBlock = block.number + 30`。
2. **攻擊模擬。** 三個哨兵程序看到 `Proposed`（WebSocket 加上 300 ms 的 `eth_getLogs` 輪詢，依 id 去重）。每個哨兵送出一個合併的 `eth_simulateV1` 請求，用 `stateOverride` 把代理合約的 ERC-1967 implementation slot 換成新程式碼，接著依序執行：基準讀取、一筆正常持有者的轉帳、從一個全新的陌生地址以多組參數呼叫新 bytecode 中找到的每一個 selector，最後再讀取一次。
3. **以不變量判定**，而不是讀原始碼（哨兵只需要 bytecode）。規則 R1–R9 列在[安全模型](#security-model)。

4. **否決。** 只要有任何違規，哨兵就在三個 RPC 上廣播一筆預先定好大小的 `veto(id, ruleHash)`（本機 nonce、固定 gas limit、不做 gas 估算）。冷靜期過後的 `execute()` 會以 `ProposalVetoed` 回滾。乾淨的升級則在 30 個區塊到期時直接執行。
5. **說明。** reporter 把模擬差異寫成一段簡短的中文風險報告，供人工多簽參考，並用 `attachReason` 把 `keccak256(text)` 附到鏈上。AI 不在否決路徑上。

守門合約也會鎖住自己：移除哨兵或縮短延遲本身也是一個提案，同樣要等 30 個區塊，並且會被否決（R7）。`breakGlass()` 讓 owner 或任何一個 guardian 立即把代理合約切換到事先登記好的暫停實作。

## 架構

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

**攻擊者。** 持有 `GuardedAdmin` 的 owner 金鑰（負責提案升級的那把金鑰；假設已外洩），可以部署任意 bytecode 而不公開原始碼，並在提案一可執行就立刻呼叫 `execute`。攻擊者沒有 guardian 金鑰，也沒有 approver 金鑰。

**我們擋下什麼。** 升級以及對守門合約本身的變更都要等 30 個區塊。`GuardedAdmin` 擁有 `ProxyAdmin`，並且自區塊 71726096 起也擁有代幣本身的 `Ownable`（[tx](https://testnet.monadexplorer.com/tx/0xc48a8d8229e33bf4e6f4aa7c71251a56b834aecd93f0b5ff61e7ea5f4b3497bb)），因此外洩的金鑰既不能直接升級，也不能直接 `mint`（兩者都會以 `OwnableUnauthorizedAccount` 回滾），而且 `GuardedAdmin` 沒有通用的呼叫路徑。冷靜期內，任何一個哨兵都可以依下列規則否決：

| 規則 | 不變量 |
| --- | --- |
| R1 | 陌生地址的呼叫不能改變 `totalSupply` |
| R2 | 陌生地址的呼叫不能改變 `owner()` |
| R3 | 轉出 X 就恰好移動 X；其他任何人的餘額都不變 |
| R3B | 陌生地址不能動用任何其他人的資金（沒有 allowance 的 `transferFrom`，或任何探測呼叫） |
| R4 | 正常轉帳仍然成功（升級不能讓合約變磚） |
| R5 | 嚴格模式：codehash 必須事先由第二把金鑰核准 |
| R6 | 模擬在兩個供應商上都失敗或逾時：fail-closed 否決 |
| R7 | 移除 guardian、縮短延遲，或更換暫停實作，都需要核准 |
| R8 | 夾帶初始化資料的升級需要已核准的 codehash |
| R9 | 新程式碼不得加入目前實作沒有的危險 opcode（區塊／交易上下文、外部呼叫、create、selfdestruct），除非它的 codehash 已核准 |

## 為什麼是 Monad

同樣 30 個區塊的冷靜期，放在不同鏈上：

| 鏈 | 出塊時間 | 30 個區塊 |
| --- | --- | --- |
| 以太坊 | ~12 s | ~6 分鐘 |
| BNB Chain | ~0.45 s | ~13.5 秒 |
| Monad 測試網 | 今天實測 ~0.30 s，終局性不到一秒 | ~9 秒（賽前探測：0.31–0.36 s/block，9.3–10.9 s；我們的說法是「約 10 秒」） |

BNB Chain 也能跑秒級的冷靜期。Monad 多給的是更細的粒度、一秒內的終局性（否決一旦落地就是最終結果，不會被鏈重組推翻），以及很低的單次否決成本；三者加起來，讓這段冷靜期短到可以永久開著。

## 測試網部署（chain 10143）

資料來自 [`shared/deployments/10143.json`](shared/deployments/10143.json)，部署於區塊 71718143。合約驗證在 MonadVision 的 Sourcify 實例上（`sourcify-api-monad.blockvision.org`）。

| 合約 | 位址 | 原始碼 |
| --- | --- | --- |
| GuardedAdmin | [`0x57a84DCaDB3C29aeF27Cd5d7f3A3Af2C27F25ef4`](https://testnet.monadexplorer.com/address/0x57a84DCaDB3C29aeF27Cd5d7f3A3Af2C27F25ef4) | Sourcify exact match |
| DemoBTC 代理合約（dBTC） | [`0xE851E12bb9987F40A5f605eb0c8008Dce6eEB3A8`](https://testnet.monadexplorer.com/address/0xE851E12bb9987F40A5f605eb0c8008Dce6eEB3A8) | OpenZeppelin TransparentUpgradeableProxy，未提交；自區塊 71726096 起代幣 owner = GuardedAdmin（deployments 檔案中的 `tokenOwner`） |
| ProxyAdmin | [`0x446d8bCD6365421fAf2BA00e1912A7A695E2caEf`](https://testnet.monadexplorer.com/address/0x446d8bCD6365421fAf2BA00e1912A7A695E2caEf) | 由代理合約建立，owner = GuardedAdmin |
| DemoBTC v1 實作 | [`0x05aB95D20800870939605Fb57fc12c09c2fC5547`](https://testnet.monadexplorer.com/address/0x05aB95D20800870939605Fb57fc12c09c2fC5547) | Sourcify exact match |
| DemoBTC v2 實作 | [`0xFb68bF421c64ef5efBa05B16B8a8C64a3b1fE5BA`](https://testnet.monadexplorer.com/address/0xFb68bF421c64ef5efBa05B16B8a8C64a3b1fE5BA) | Sourcify exact match |
| PausedImpl | [`0xd04Ba153293d643C696f3076051A89422447d4EB`](https://testnet.monadexplorer.com/address/0xd04Ba153293d643C696f3076051A89422447d4EB) | breakGlass 的切換目標 |
| EvilMintImpl | [`0x074E2C925d2621479226d9A277e90AF2B724B8A2`](https://testnet.monadexplorer.com/address/0x074E2C925d2621479226d9A277e90AF2B724B8A2) | 示範攻擊，刻意不驗證 |
| EvilOwnerImpl | [`0x712Cc2780419a06f15fF3c7D1DA47C6Ee4875659`](https://testnet.monadexplorer.com/address/0x712Cc2780419a06f15fF3c7D1DA47C6Ee4875659) | 示範攻擊，刻意不驗證 |
| EvilFeeImpl | [`0x68E90762e9914328Af6A3eA3aA914471124aF1d1`](https://testnet.monadexplorer.com/address/0x68E90762e9914328Af6A3eA3aA914471124aF1d1) | 示範攻擊，刻意不驗證 |

攻擊實作是刻意不驗證的：真正的攻擊者不會公開原始碼，而哨兵只依 bytecode 判定。Guardian：`0x7ED9…EF3b`、`0xd662…6B68`、`0x94b5…98bE`（完整清單在 deployments 檔案）。

Arena 跑在自己的一組合約上，所以訪客的提案絕不會碰到舞台展示用的部署：GuardedAdmin [`0x1d286Ef4D622EFD91FeDe3560fB4Cff0D4ff0c59`](https://testnet.monadexplorer.com/address/0x1d286Ef4D622EFD91FeDe3560fB4Cff0D4ff0c59)、DemoBTC 代理合約 [`0x5E58083bA85add746592352D49d3Db8f4E5A1a95`](https://testnet.monadexplorer.com/address/0x5E58083bA85add746592352D49d3Db8f4E5A1a95)，部署於區塊 71767314（GuardedAdmin、DemoBTC v1 與 v2 皆為 Sourcify exact match；完整清單在 [`shared/deployments/10143-arena.json`](shared/deployments/10143-arena.json)）。

## 今天在 Monad 測試網的實測（會場網路，2026-10-17）

**下午的幾輪（提案 #3–#9）**

| # | 卡片 | 提案區塊 | 第一筆否決落地 | `proposal_seen` 到否決收據 | 結果 |
| --- | --- | --- | --- | --- | --- |
| 3 | EvilMint | 71723855 | +5 個區塊 | 1768 ms | 3/3 否決 |
| 4 | EvilOwner | 71723873 | +5 個區塊 | 1740 ms | 3/3 否決 |
| 5 | EvilFee | 71723893 | +16 個區塊 | 7.4 s | 3/3 否決 |
| 6 | EvilFee | 71724344 | +6 個區塊 | 1969 ms | 3/3 否決 |
| 7 | v2 | 71724368 | — | — | 3/3 放行；30 個區塊冷靜期過後在區塊 71724402 執行（[tx](https://testnet.monadexplorer.com/tx/0x4b831ca82af42363bd56de34405a4d46ff87982c02c298d70af05430db9df121)） |
| 8 | EvilFee | 71724394 | **+4 個區塊** | **1314 ms**（最快的哨兵 1252 ms） | 3/3 否決 |
| 9 | EvilOwner | 71724850 | +6 個區塊 | — | 3/3 否決 |

每一個被否決的提案，其 `execute` 都以 `ProposalVetoed` 回滾。典型結果：否決在提案後 4–7 個區塊落地，此時攻擊者離 `readyBlock` 還差 23–26 個區塊；每一筆否決都在冷靜期內落地。

提案 #8（EvilFee，規則 R3）的鏈上紀錄：

| 項目 | 交易 |
| --- | --- |
| 提案，區塊 71724394（可執行區塊 71724424） | [`0x2b0585d04013a24d605461472a43dcb16afea520a9bea65f3d5be56415938a78`](https://testnet.monadexplorer.com/tx/0x2b0585d04013a24d605461472a43dcb16afea520a9bea65f3d5be56415938a78) |
| 第一筆 `Vetoed`，區塊 71724398（三筆否決都在這個區塊） | [`0x7a96dd70cfb0aadadcaa231ac5bb3b8d7fd4b8025df1ea107e10ab025593f290`](https://testnet.monadexplorer.com/tx/0x7a96dd70cfb0aadadcaa231ac5bb3b8d7fd4b8025df1ea107e10ab025593f290) |
| `execute(8)`，區塊 71724427，以 `ProposalVetoed` 回滾 | [`0x48ca61e05beee8ec16bab69f46738681159156d91a2adf3f0c7eb73c3a80160c`](https://testnet.monadexplorer.com/tx/0x48ca61e05beee8ec16bab69f46738681159156d91a2adf3f0c7eb73c3a80160c) |

**單次否決成本。** gas limit = gas used = 123,112（Monad 依 gas limit 收費）。以 102 gwei 計為 ~0.01256 MON（提案 #1–#8）；之後加上 10 gwei 的 priority fee 下限，變成 110 gwei，~0.01354 MON（從 #9 起）。

**第一輪，冷連線（EvilMint，提案 #1）**

| 項目 | 結果 |
| --- | --- |
| 提案 | 區塊 71719034（[tx](https://testnet.monadexplorer.com/tx/0x03d9d828f91bad755da8d19f5d37633558501eb98eb32e2386797ee79a5fdae8)），可執行區塊 71719064 |
| 判定 | 3 個哨兵全部：否決，規則 R1（陌生地址的 `mint` 改變了 `totalSupply`） |
| 第一筆否決落地 | 區塊 71719043（[tx](https://testnet.monadexplorer.com/tx/0x165a1878e550b57ec85309313fe8841fc73de18dee48bc287b13f81773a318b9)）：**提案後 9 個區塊，比攻擊者能執行的時間早 21 個區塊**；第 2、3 筆否決分別在區塊 71719044 和 71719045 |
| `proposal_seen` 到否決收據 | 2681 ms（另外兩個哨兵：3060 ms、3556 ms） |
| 模擬時間（`simMs`） | 2236 / 2573 / 2308 ms，其中 `eth_simulateV1` 請求本身是 1399 / 804 / 689 ms；其餘大部分是冷連線的建立時間 |
| 單次否決成本 | 123,112 gas，以 102 gwei 計 = ~0.0126 MON |
| 攻擊者的 `execute(1)` | 區塊 71719073，以 `ProposalVetoed` 回滾（[tx](https://testnet.monadexplorer.com/tx/0x21fe66f76256e6a385de8bcf113bf252ff907d0fa186893b0634933ac5def169)） |
| 鏈上的風險報告雜湊 | 區塊 71719050 的 `attachReason`（[tx](https://testnet.monadexplorer.com/tx/0x703284958ce96e1cf078e4d80b049717982bcb59364974cad212badf41c25211)） |

**正常升級（v2，提案 #2）**

| 項目 | 結果 |
| --- | --- |
| 提案 | 區塊 71719341（[tx](https://testnet.monadexplorer.com/tx/0x7d1e60ae02678762974382745838bffbc91ef26d691fa86f9bf2d8bb9e991c57)），可執行區塊 71719371 |
| 判定 | 3 個哨兵全部：放行（1670 / 1682 / 2689 ms） |
| 執行 | 區塊 71719382，在 30 個區塊冷靜期之後（[tx](https://testnet.monadexplorer.com/tx/0x21aa34ff8486469761492fd66594d2d928f352f54dbaaf007bb1f1f9e21a1939)）；`version()` 回傳 `"2"` |

**網路備註。** 依區塊 71718143–71719382 的區塊時間戳計算，每個區塊 ~0.30 s。在會場網路上，新建一條 TLS 連線要 1.3–1.7 s，而在保持連線（keep-alive）的情況下，一次讀取約 320 ms、`eth_simulateV1` 約 400 ms，所以哨兵和 driver 都會讓連線保持熱機，並在供應商之間故障切換。driver 透過 ankr 加上官方 RPC 讀取。只有 `testnet-rpc.monad.xyz` 和 `10143.rpc.thirdweb.com` 提供 `eth_simulateV1`；哨兵只用它們做模擬，其他的則用於 logs、心跳與廣播。

在本機 anvil（`--network monad -b 0.3`）上，4 張卡跑 5 輪：判定錯誤 0 次，每一筆否決都在提案後 1 個區塊落地，`proposal_seen` 到否決收據 299–309 ms；關掉一個哨兵後，另外兩個仍然否決了每一次攻擊（細節見 [`sentinel/NOTES.md`](sentinel/NOTES.md)）。

## 如何執行

需求：Foundry、Node 22+。在 `sentinel/`、`driver/`、`reporter/` 和 `web/` 各執行一次 `npm install` 安裝套件。

### 本機（anvil）

```bash
anvil --network monad -b 0.3 --port 8545
RPC_URL=http://127.0.0.1:8545 script/deploy.sh      # writes shared/deployments/anvil.json
sh sentinel/run.sh anvil                            # 3 sentinels, SSE on 8701-8703
(cd driver && npm start)                            # DEPLOYMENT=anvil by default, port 8700
(cd reporter && npm start)                          # port 8710; LLM_DISABLE=1 for template-only
(cd web && npm run dev)                             # http://127.0.0.1:5173/?mode=replay
```

本機模式只使用 anvil 公開的測試帳號。

### Monad 測試網（10143）

上面的合約都已經部署好；要重新部署請看 `script/deploy.sh`（預設為 dry run，設 `BROADCAST=1` 才會送出）。金鑰在執行時從檔案讀取（每個檔案一把 hex 金鑰），絕不會印出來。

```bash
KEY_DIR=<key dir> sh sentinel/run.sh testnet        # sentinel1.key .. sentinel3.key
                                                    # DRY_RUN=1: judge and sign, never broadcast
(cd driver && DEPLOYMENT=10143 DRIVER_BROADCAST=1 KEY_DIR=<key dir> \
  RPC_URLS=https://rpc.ankr.com/monad_testnet,https://testnet-rpc.monad.xyz npm start)
(cd reporter && npm start)
(cd web && npm run dev)                             # http://127.0.0.1:5173/?mode=testnet
```

### 不連鏈

```bash
node sentinel/fake-events.mjs                       # fake sentinel SSE (FAKE_DRIVER=1 FAKE_REPORTER=1 for 8700/8710)
(cd web && npm run dev)                             # http://127.0.0.1:5173/?mode=fake
```

### 測試

```bash
forge test                                          # 33 GuardedAdmin tests (cooldown, veto, guard self-locking, breakGlass, token ownership)
node --test sentinel/test/unit.test.mjs             # offline sentinel unit tests
(cd reporter && npm test)                           # fake sentinels + fake LLM, no chain
ROUNDS=5 node sentinel/test/e2e-anvil.mjs           # needs anvil + deploy + 3 running sentinels
```

## 儲存庫結構

| 路徑 | 內容 |
| --- | --- |
| `src/GuardedAdmin.sol` | 冷靜期、guardian 否決、approver 登記、breakGlass；ProxyAdmin 的 owner |
| `src/DemoBTC.sol`, `src/DemoBTCV2.sol`, `src/PausedImpl.sol` | 示範代幣（dBTC，8 位小數）v1/v2 與暫停實作 |
| `src/attack/` | EvilMintImpl（R1）、EvilOwnerImpl（R2）、EvilFeeImpl（R3）：示範攻擊程式碼 |
| `test/GuardedAdmin.t.sol` | Foundry 測試 |
| `script/` | `Deploy.s.sol` + `deploy.sh`（一次完成部署）、`measure-gas.sh`、`export-shared.sh` |
| `sentinel/` | 哨兵程序：偵測、合併模擬、規則 R1–R9、否決簽署器、SSE（[NOTES](sentinel/NOTES.md)） |
| `reporter/` | 風險報告產生器：本機 LLM，備援用範本，雜湊附到鏈上（[README](reporter/README.md)） |
| `driver/` | 戰情室的展示驅動程式：提案卡片、自動執行、核准 codehash |
| `web/` | 戰情室前端（Vite + TypeScript + viem） |
| `arena/` | 雲端 Arena：引擎 Worker + Durable Object（`arena/worker`）、帶 service binding 的 Pages 前端（`arena/pages`） |
| `shared/` | 各部分共用的 ABI、部署位址、gas limit、規則雜湊表 |
| `docs/` | `spec.md`（賽前的純文字規格）、`contracts-cheatsheet.md`（手動 `cast` 操作） |
| `slides/` | 離線簡報（`slides/index.html`，用方向鍵翻頁） |
| `submission/` | 活動提交用的中繼資料 |
| `scripts/` | 通用的 RPC 與區塊標頭探測工具、通用的部署／驗證包裝腳本 |
| `broadcast/` | 測試網部署的 Foundry broadcast 紀錄 |

## 賽前準備（僅限樣板）

依照 Blitz「只有樣板程式碼與研究／規劃可以事先準備」的規則，第一個 commit 包含通用的骨架和一份純文字規格。其中沒有任何應用程式邏輯。

| 項目 | 來源 |
| --- | --- |
| `foundry.toml`, `remappings.txt` | Foundry 預設值，加上 Monad 文件中的 Monad 設定（solc 版本、`evm_version`、`network = "monad"`、公開測試網 RPC 清單、Sourcify verifier 網址） |
| `src/Counter.sol`, `test/Counter.t.sol`, `script/Counter.s.sol` | `forge init` 範本，只為了證明工具鏈能編譯而保留；已在活動期間移除 |
| `lib/forge-std` v1.17.0, `lib/openzeppelin-contracts` v5.7.0, `lib/openzeppelin-contracts-upgradeable` v5.7.0 | 上游的 release tag，直接收進儲存庫（vendored） |
| `web/`（初版） | `create-vite` vanilla-ts 範本、一個 Monad 測試網用、帶多 RPC 備援 transport 的 viem `defineChain`，以及一個顯示目前區塊的空白頁面 |
| `scripts/rpc-health.sh`, `scripts/heads.mjs` | 通用的 RPC 健康檢查與區塊標頭探測（開發工具） |
| `scripts/deploy.sh`, `scripts/verify.sh` | 通用的 `forge create` / `forge verify-contract --verifier sourcify` 包裝腳本 |
| `.gitignore`, `.env.example`, `LICENSE` | 標準的專案中繼資料 |
| `docs/spec.md` | 作為規劃而寫的純文字規格、威脅模型與介面清單；不含任何程式碼 |

**所有應用程式邏輯都是在 2026-10-17 的 Monad Blitz Shanghai 期間寫的**：`src/` 裡的合約、測試、部署腳本、哨兵、reporter、driver、戰情室介面，以及這些文件和簡報。commit 歷史可以看到樣板 commit 之後新增的所有內容。

## 使用的 AI 工具

- **活動期間：** Claude Code 以多個平行代理（合約、哨兵、戰情室、reporter、文件）執行，依 `docs/spec.md` 撰寫程式碼與文件；作者負責指揮、審查、部署，並執行測試網展示。
- **活動之前：** Claude Code 協助準備上面列出的樣板與規劃規格。
- **產品內部：** 有可用的本機 Qwen 模型時，reporter 會透過 LM Studio 用它撰寫風險報告；否則改用規則式範本（介面上會標示為範本）。今天測試網執行產生的報告都是範本報告。不論哪一種，報告都只負責說明；否決決定由哨兵的不變量檢查做出。

## 範圍與下一步

Eleven Seconds 保護的是**升級路徑**：代理合約實作的變更，以及守門合約自身設定（guardian、延遲、暫停實作）的變更。模擬能抓到「陌生地址可以改變狀態」這一類升級；新增的區塊與交易上下文 opcode 由 R9 標記，而行為取決於特定呼叫者的升級，則是嚴格模式（R5）要處理的。三個哨兵是各自持有獨立金鑰的獨立程序。

下一步：

1. **預設啟用嚴格模式**：每個新的 codehash 都需要第二把金鑰事先核准（R5 已經實作，透過 `STRICT=1` 開啟）。
2. **押保證金的哨兵網路**：任何人只要繳交保證金就能執行哨兵，守門合約因此不必依賴單一操作者的機器。
3. **多簽推翻**：一條有延遲、經多簽核准的路徑，可以推翻否決。
4. 把其他特權角色（例如 minter）也放到同樣的冷靜期後面。
5. **提案過期與 `cancel()`**：待處理的提案會逾時，owner 或 guardian 可以取消提案。
6. **breakGlass 清空佇列**：切換到暫停實作時，也會取消排隊中的升級。

## 授權

MIT，見 [LICENSE](LICENSE)。作者：Ted Chen。
