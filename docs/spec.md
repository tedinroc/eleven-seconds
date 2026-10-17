> **Pre-event planning document, no code.** Written before Monad Blitz Shanghai (2026-10-17) as a plain-text spec / threat model / interface list. All implementation was written during the event.

# 規格卡：升級冷靜期＋哨兵否決（產品名見 README）

> 純文字規格，不含程式碼。第 3–5 節是各模組共用的介面約定。

---

## 1. 產品規格卡

| 欄位 | 內容 |
|---|---|
| 一句話 | 攻擊者偷到升級鑰匙後幾秒就能升級；我們讓每次升級先等 30 個區塊（Monad 約 10 秒，賽前實測 0.31–0.36 秒/塊；畫面一律顯示實測值），這段時間裡哨兵先把新合約當攻擊者打一遍，有問題就否決。 |
| 使用者 | 有可升級合約（OZ Transparent Proxy + ProxyAdmin）的 Monad 團隊 |
| 導入方式 | 部署 GuardedAdmin，把 ProxyAdmin 的 owner 轉給它一次；原 proxy 不必重新部署 |
| 核心機制 | 1) 提案 → 30 塊冷靜期 → 執行；2) 任一 guardian 可在執行前否決；3) 3 個獨立哨兵用 eth_simulateV1＋stateOverride 對新 impl 做攻擊模擬與不變量檢查；4) breakGlass 立即切到預註冊的暫停實作 |
| AI 的位置 | 不在否決關鍵路徑上。本機 Qwen 根據模擬差異寫一段中文風險報告，hash 用 attachReason 附到提案上，給人類多簽參考 |
| 成功的 demo | 惡意升級被否決、execute 回 revert；正常升級 30 塊後生效；畫面顯示實測「否决用了 X 块／攻击者还要等 Y 块」與單次否決成本 |
| 不做 | 觀眾掃碼、主網部署、真實資產、跨鏈、哨兵押金經濟、多簽 override 流程（列為下一步） |
| 示範資產 | DemoBTC（符號 dBTC）。**不要叫 BTC+ 或任何真實產品名** |

---

## 2. 威脅模型

### 2.1 角色與鑰匙

| 角色 | 鑰匙標籤 | 權限 | 演示中的身分 |
|---|---|---|---|
| deployer | deployer | 只負責部署，部署完不留任何權限 | — |
| owner | admin | GuardedAdmin 的 owner：可提案、可 breakGlass | 演示情境假設這把已外洩：攻擊者與正常運維都用它 |
| guardian ×3 | sentinel1 / sentinel2 / sentinel3 | 否決、附報告、breakGlass | 3 個獨立哨兵進程，各用自己的鑰匙 |
| approver | approver | 預核准 codehash（嚴格模式用） | 第二把鑰匙，代表另一位簽署人 |
| 陌生地址 | 無（模擬時臨時產生） | 無 | 哨兵模擬攻擊時扮演的「任何人」 |

鑰匙注資由操作者手動進行，任何自動程序都不做轉帳。注資量：deployer 10、admin 與 sentinel1–3 各 3、approver 2 MON（合計 24）。這些鑰匙只呼叫合約、不轉 value，Monad 的 reserve balance 規則不影響這類呼叫，餘額只需足以支付 gas limit × gas price。

### 2.2 攻擊者能力與我們的回應

| # | 攻擊 | 前提 | 我們的回應 | 結果 |
|---|---|---|---|---|
| T1 | 用被盜 admin 提案升級成無權限 mint 的 impl（Solv 模式） | admin 外洩 | 哨兵模擬：陌生地址呼叫後 totalSupply 改變 → 否決 | execute revert |
| T2 | 升級成可搶 owner 的 impl | 同上 | 模擬：陌生地址呼叫後 owner 改變 → 否決 | 同上 |
| T3 | selector 完全不變，但 transfer 偷抽成 | 同上 | 模擬：轉帳不守恆 → 否決（bytecode 規則抓不到，這是我們的亮點） | 同上 |
| T4 | 先拔掉 guardian 再升級 | 同上 | 拔 guardian 也是提案、也要等 30 塊；哨兵規則一律否決未經 approver 核准的「移除 guardian／縮短延遲／更換暫停實作」 | 拔不掉 |
| T5 | 縮短延遲到 0 | 同上 | 合約下限 MIN_DELAY_BLOCKS；縮短也走延遲且會被哨兵否決 | 擋下 |
| T6 | 繞過 GuardedAdmin 直接呼叫 ProxyAdmin | admin 外洩 | ProxyAdmin owner 已是 GuardedAdmin，admin EOA 無權 | revert |
| T7 | 搶在否決前 execute | 同上 | execute 需 block.number ≥ readyBlock；否決通常在 6–12 塊內落地 | revert |
| T8 | 灌爆提案讓哨兵忙不過來 | 同上 | 每個提案都獨立模擬；超時一律 fail-closed 否決 | 否決 |
| T9 | 在 init data 裡夾帶惡意呼叫 | 同上 | 提案 data 非空且 codehash 未經 approver 核准 → 否決（fail-closed） | 否決 |

### 2.3 設計範圍與下一步

1. 只保護升級這條路。minter 之類的特權角色若不放在延遲後面，可以被繞過。
2. 模擬抓不到定時炸彈型後門（只對特定地址、特定區塊後才生效）。正式版應開嚴格模式：未經 approver 預核准 codehash 的升級一律否決。
3. 哨兵全部掉線時，冷靜期窗口等於沒有保護；誤判會擋掉正常升級，需要人類 override（本次不做）。
5. 業界已有 OZ TimelockController、Forta、Hypernative；我們的差異是延遲短到團隊沒理由不裝，並且是可直接替換的開源元件。

---

## 3. 合約介面

### 3.1 常數

| 名稱 | 值 | 說明 |
|---|---|---|
| DELAY_BLOCKS（建構參數預設） | 30 | 冷靜期，以 block.number 計，不用 timestamp（timestamp 1 秒精度，約 3 塊共用一個值） |
| MIN_DELAY_BLOCKS | 10 | 縮短延遲的下限 |
| MAX_DELAY_BLOCKS | 50400 | 約 4.2 小時 |
| MAX_GUARDIANS | 8 | |
| MIN_GUARDIANS | 1 | 合約層下限；真正的保護是「移除要走延遲且會被否決」 |

### 3.2 列舉

| 列舉 | 值 |
|---|---|
| Kind | 0 Upgrade、1 SetGuardian、2 SetDelay、3 SetPausedImpl |
| Status | 0 None、1 Pending、2 Vetoed、3 Executed |

### 3.3 GuardedAdmin 函式

| 函式簽名 | 呼叫者 | 規則 | 事件 |
|---|---|---|---|
| `constructor(address proxyAdmin, address proxy, address owner, address[] guardians, address approver, address pausedImpl, uint64 delayBlocks)` | deployer | 位址不得為 0；pausedImpl 必須有 code；delay 在上下限內 | GuardianSet ×N |
| `proposeUpgrade(address newImpl, bytes data) returns (uint256 id)` | owner | newImpl 必須有 code；記錄 codehash；readyBlock = block.number + delayBlocks | Proposed |
| `proposeSetGuardian(address guardian, bool enabled) returns (uint256 id)` | owner | 同上延遲；execute 時檢查上下限 | Proposed |
| `proposeSetDelay(uint64 newDelay) returns (uint256 id)` | owner | 同上延遲；值在上下限內 | Proposed |
| `proposeSetPausedImpl(address impl) returns (uint256 id)` | owner | 同上延遲；impl 必須有 code | Proposed |
| `execute(uint256 id)` | 任何人 | status 必須 Pending、block.number ≥ readyBlock；Upgrade 走 ProxyAdmin.upgradeAndCall；若目前 paused，Upgrade 執行後解除 paused（＝unpause 也走延遲） | Executed |
| `veto(uint256 id, bytes32 ruleHash)` | guardian | status 為 Pending → 改 Vetoed；status 已是 Vetoed → 不改狀態、vetoCount＋1、照發事件（冪等，讓畫面亮出 3/3）；Executed 或 None → revert | Vetoed |
| `attachReason(uint256 id, bytes32 reportHash)` | guardian | 提案存在即可（任何狀態） | ReasonAttached |
| `approveCodehash(bytes32 codehash)` | approver | 只是登記，合約本身不依它放行；給嚴格模式的哨兵讀 | CodehashApproved |
| `breakGlass()` | owner 或 guardian | 立即透過 ProxyAdmin 把 proxy 切到 pausedImpl，paused = true；已 paused 則 revert | BrokeGlass |

**View**：`getProposal(uint256 id)`（回傳 kind、status、proposer、target、value、codehash、dataHash、proposedBlock、readyBlock、vetoCount）、`nextId()`、`isGuardian(address)`、`guardianCount()`、`delayBlocks()`、`paused()`、`pausedImpl()`、`approver()`、`isApprovedCodehash(bytes32)`、`proxy()`、`proxyAdmin()`、`isWired()`（ProxyAdmin.owner() 是否為本合約）。

id 從 1 起算，0 保留為「不存在」。

### 3.4 事件

| 事件簽名 | indexed | 說明 |
|---|---|---|
| `Proposed(uint256 id, uint8 kind, address target, uint256 value, bytes data, bytes32 codehash, uint64 readyBlock)` | id、kind、target | Upgrade：target＝newImpl、value＝0；SetGuardian：target＝guardian、value＝1 加入／0 移除；SetDelay：target＝0、value＝新延遲；SetPausedImpl：target＝impl |
| `Vetoed(uint256 id, address guardian, bytes32 ruleHash, uint256 vetoCount)` | id、guardian | 冪等，第 2、3 個哨兵也會發 |
| `Executed(uint256 id, address executor)` | id | |
| `ReasonAttached(uint256 id, address guardian, bytes32 reportHash)` | id | |
| `CodehashApproved(bytes32 codehash, address approver)` | codehash | |
| `BrokeGlass(address caller, address pausedImpl)` | caller | |
| `GuardianSet(address guardian, bool enabled)` | guardian | 建構與 SetGuardian 執行時發 |

### 3.5 自訂錯誤

| 錯誤簽名 | 何時 |
|---|---|
| `NotOwner()`、`NotGuardian()`、`NotApprover()`、`NotOwnerOrGuardian()` | 權限不符 |
| `UnknownProposal(uint256 id)` | id 不存在 |
| `TooEarly(uint256 id, uint64 readyBlock, uint64 currentBlock)` | 冷靜期未滿就 execute |
| `ProposalVetoed(uint256 id)` | 對已否決提案 execute（demo 畫面要顯示這個名字） |
| `AlreadyExecuted(uint256 id)` | 重複 execute，或對已執行提案 veto |
| `InvalidDelay(uint64 value)`、`GuardianBounds(uint256 count)` | 參數越界 |
| `ZeroAddress()`、`NoCode(address target)`、`AlreadyPaused()` | 其他 |

（錯誤與事件不可同名，所以否決的錯誤叫 ProposalVetoed。）

### 3.6 示範合約

| 合約 | 內容 | 哨兵預期 |
|---|---|---|
| DemoBTC v1 | OZ upgradeable 5.7.0 的 ERC20 + Ownable（ERC-7201 命名空間儲存），`initialize(address owner, address[] holders, uint256[] amounts)`；有 onlyOwner 的 `mint(address,uint256)`；建構子禁用 initializer | — |
| DemoBTC v2 | 繼承 v1，只多 `version()` 回傳 "2" | 放行 |
| EvilMintImpl | `mint(address,uint256)` 不檢查呼叫者（selector 與 v1 相同，所以光比 selector 抓不到） | 否決 R1 |
| EvilOwnerImpl | 新增 `claimOwner()`，無權限檢查 | 否決 R2 |
| EvilFeeImpl | selector 完全不變，transfer 偷抽 10% 給 owner | 否決 R3 |
| PausedImpl | 同儲存佈局；view 正常，轉帳／mint 全 revert | breakGlass 目標 |

部署流程：deployer 部署 v1 impl → 部署 TransparentUpgradeableProxy（initialOwner＝admin，自動產生 ProxyAdmin）→ 部署 GuardedAdmin → admin 呼叫 ProxyAdmin.transferOwnership(GuardedAdmin)（＝導入那一步，畫面可展示）。惡意 impl 只部署、**不上 Sourcify 驗證**（攻擊者不會公開原始碼，哨兵只看 bytecode）；GuardedAdmin 與 DemoBTC 要驗證。

### 3.7 共用檔案（A 線產出，B、C 線讀）

| 檔案 | 內容 |
|---|---|
| `shared/abi/GuardedAdmin.json`、`shared/abi/DemoBTC.json` | 從 forge out 匯出的 ABI |
| `shared/deployments/anvil.json`、`shared/deployments/10143.json` | chainId、guardedAdmin、proxyAdmin、proxy、impls（v1、v2、evilMint、evilOwner、evilFee、paused）、owner、guardians[3]、approver、holders[]、deployBlock |
| `shared/gas.json` | 在 anvil（`--network monad`）量到的 gasUsed 與建議 gas limit（×1.10）：propose、veto、attachReason、execute、breakGlass、approveCodehash |
| `shared/rules.json` | 規則 ID 與 ruleHash 對照（見 4.3） |

---

## 4. 哨兵規格

### 4.1 輸入與輸出

| 方向 | 內容 |
|---|---|
| 輸入：鏈上 | `Proposed` 事件（WS monadLogs 與 300ms eth_getLogs 輪詢雙路徑）、新 impl 的 bytecode（eth_getCode）、目前 impl（讀 ERC-1967 實作 slot，用 OZ ERC1967Utils 定義的 slot 常數，不手刻） |
| 輸入：設定 | deployments json、gas.json、rules.json、自己的鑰匙檔路徑（環境變數）、RPC 優先序、STRICT 開關、watchlist 地址（owner、holders） |
| 輸出：鏈上 | `veto(id, ruleHash)`；收到 reporter 請求時代送 `attachReason(id, reportHash)`（同一把鑰匙只由一個進程送，避免 nonce 打架） |
| 輸出：本機 | SSE 事件流 `http://127.0.0.1:870{1,2,3}/events`、健康檢查 `/health`、本機 `POST /attach`（給 reporter） |

### 4.2 不變量清單

每個提案做一次「基準讀取 → 攻擊呼叫 → 事後讀取」的 eth_simulateV1，stateOverride 把 proxy 的實作 slot 換成新 impl。

| 規則 ID | 不變量 | 怎麼打 | 違反就 |
|---|---|---|---|
| R1_TOTAL_SUPPLY | 陌生地址的任何呼叫都不能改變 totalSupply | 新 impl 裡掃出的每個 selector，用陌生地址、幾組通用參數（無參數、陌生地址、陌生地址＋大數、大數）呼叫 | 否決 |
| R2_OWNER | 陌生地址的任何呼叫都不能改變 owner() | 同上 | 否決 |
| R3_TRANSFER_CONSERVATION | holder 轉 X 給新地址：holder 少 X、新地址多 X、watchlist 其他人與 totalSupply 不變 | from＝現有 holder（模擬不驗簽） | 否決 |
| R4_TRANSFER_LIVENESS | 上面那筆正常轉帳必須成功 | 同上 | 否決（防「升級成磚頭」） |
| R5_STRICT_CODEHASH | STRICT=1 時，codehash 必須已 approveCodehash | 讀 isApprovedCodehash | 否決 |
| R6_SIM_FAILURE | 模擬本身失敗、逾時或 view 函式 revert（細節見 4.2.2） | 逾時或 429 時先換另一家模擬 RPC 重試一次 | 兩家都失敗才 fail-closed 否決 |
| R7_CONFIG_GUARD | 移除 guardian、縮短延遲、更換 pausedImpl，未經 approver 核准 | 看 Proposed 的 kind/value | 否決 |
| R8_INIT_DATA | Upgrade 的 data 非空且 codehash 未核准 | 看 Proposed 的 data | 否決 |

ruleHash ＝ 規則 ID 字串（如 `GUARD/R1_TOTAL_SUPPLY`）的 keccak256，對照表放 shared/rules.json，前端與報告共用。

#### 4.2.1 eth_simulateV1 參數限制（賽前唯讀實測，2026-10-17 01:xx UTC+8）

| 項目 | 實測結果 | 規則 |
|---|---|---|
| 支援的端點 | 只有 testnet-rpc.monad.xyz 與 10143.rpc.thirdweb.com 能跑。rpc-testnet.monadinfra.com、rpc.ankr.com/monad_testnet 回 -32601 Method not found；monad-testnet.drpc.org 回「free plan 不提供」 | 模擬只打這兩家 |
| `validation` 欄位 | 兩家只要帶 `"validation": false` 就回 -32000「is not supported yet」，整個請求失敗 | **不要送 validation 欄位**；用 viem 時要確認序列化後的請求沒有帶出 `validation: false` |
| gasUsed | 回傳的 gasUsed 等於該 call 的 gas limit（沒指定時是 150,000,000，指定 200000 就回 200000），不是實際用量 | **每個 call 都明確給 gas**；sim 的 gasUsed **不能**拿來寫 gas.json（gas.json 只用 anvil 實際交易收據） |
| stateOverride | `code`＋`stateDiff` 與 `code`＋`state` 兩種覆蓋都有效 | 換實作 slot 用 stateDiff（保留其他 storage） |
| 區塊內狀態 | 同一個 blockStateCalls 區塊內，前一個 call 寫入的狀態會延續到下一個 call | 「基準讀取 → 攻擊呼叫 → 事後讀取」可串在同一區塊 |
| 一次的 call 數 | 一次 150 個 call 可以過 | 合併請求上限先抓 150，超過就拆 |
| 延遲 | 兩家約 0.9–1.5 秒（賽前網路）；會場網路未知 | 逾時值開工時現場量測後設定（見 4.2.2） |

#### 4.2.2 R6 逾時與重試

1. 逾時是設定值，不寫死。開工時在現場網路量過模擬延遲再定；建議起始值：單次 2.5 秒、整個模擬（含重試）總預算 5 秒。30 個區塊約 10 秒的窗口扣掉否決上鏈時間仍夠用。
2. 模擬請求逾時、HTTP 429 或網路錯誤：**換另一家模擬 RPC 重試一次**（官方 ↔ thirdweb）。
3. 兩家都失敗（或總預算用完）才觸發 R6 fail-closed 否決。
4. 模擬「成功回傳但結果違反不變量」不重試，直接走對應規則否決。
5. view 函式在模擬裡 revert 屬於 R6，不重試。

#### 4.2.3 RPC 請求預算（避免撞 429 造成誤否決）

| 用途 | 端點 | 說明 |
|---|---|---|
| eth_simulateV1 | 只用 testnet-rpc.monad.xyz、10143.rpc.thirdweb.com | 3 個哨兵就有 2 個共用同一家，對外說「2 家模擬供應商」。每個提案每個哨兵只送 1 個合併請求（失敗才重試 1 次）。thirdweb 公開版在突發時 48 次裡有 25 次回 429，官方端點每個 IP 每秒限 15 次，所以除模擬外不打這兩家 |
| eth_getLogs 輪詢（300ms）、心跳讀區塊 | rpc-testnet.monadinfra.com、rpc.ankr.com/monad_testnet | 3 個哨兵錯開；monadinfra 平行打會 429，要節流 |
| WS 訂閱 | wss://testnet-rpc.monad.xyz、wss://rpc-testnet.monadinfra.com | 只有這兩家有 WS；前端也走 WS，斷線才退回輪詢 |
| 廣播否決 tx | 三路：官方、monadinfra、ankr | 廣播次數極少，不影響模擬額度 |

### 4.3 否決流程

| 步驟 | 規則 |
|---|---|
| 1 偵測 | 收到 Proposed（Proposed 階段就推送）立刻開工；兩條路徑都可能送到，**用 proposal id 去重** |
| 2 模擬 | 先送一個合併請求（所有攻擊呼叫串在同一模擬區塊裡）；全部通過就放行；任一違反就**先送否決**，事後再逐個 selector 歸因（給報告用） |
| 3 否決 | nonce 本地管理、gas limit 讀 gas.json 寫死（**不估 gas**）、fee 背景每 10 秒更新、chainId 寫死；有空檔時先對 nextId 的每條規則預簽好否決交易 |
| 4 廣播 | 同一筆 raw tx 三路同時送：主路用 eth_sendRawTransactionSync，其餘用 eth_sendRawTransaction；「already known／nonce too low」視為正常 |
| 5 確認 | Sync 收據只代表 Proposed；要等否決 tx 的區塊到 Finalized 才發 `veto_finalized`。提案的 log 若在 Finalized 前消失，發 `proposal_dropped` |
| 6 放行 | 通過則不發任何交易，只發 `sim_result: pass` |

RPC：模擬只用 testnet-rpc.monad.xyz 與 10143.rpc.thirdweb.com（兩者都支援 eth_simulateV1 與 storage override，彼此互為重試對象）。rpc.ankr.com/monad_testnet 與 rpc-testnet.monadinfra.com **不能跑 simulateV1**（-32601），只用於 WS（僅 monadinfra）、getLogs、心跳與廣播；monadinfra 平行打會 429。monad-testnet.drpc.org 免費版不提供 simulateV1，不用於模擬。分工見 4.2.3。

### 4.4 SSE 事件格式（B 線產出，C 線與 reporter 讀）

每則事件一行 JSON，共同欄位：`v`（固定 1）、`type`、`ts`（毫秒）、`mode`（testnet／replay）、`source`（sentinel-1..3／driver／reporter）。

| type | 其他欄位 |
|---|---|
| heartbeat | lastBlock、rpc、ok（每 500ms 一次；前端 2 秒沒收到就判離線） |
| proposal_seen | id、kind、target、codehash、proposeBlock、readyBlock、path（ws／poll） |
| sim_started | id |
| sim_result | id、verdict（pass／veto）、rule、ruleHash、checks（每條：name、before、after、ok）、selectorsAdded、simMs |
| veto_sent | id、txHash、rpcs |
| veto_receipt | id、txHash、block、status、gasUsed、gasLimit、effectiveGasPrice、latencyMs（從 proposal_seen 起算） |
| veto_finalized | id、txHash、block |
| proposal_dropped | id |
| reason_attached | id、txHash、reportHash |
| execute_attempt（driver） | id、txHash、result（success／reverted）、error（例如 ProposalVetoed） |
| report_token／report_done（reporter） | id、delta／text、hash、cached（是否為模板報告） |

---

## 5. 前端畫面清單

| # | 畫面 | 內容 |
|---|---|---|
| S1 | 戰情室主畫面（1280×720） | 頂部：模式徽章（「Monad 测试网 10143」／灰色「本机重演」）＋大區塊計數器（≥96px，每塊跳一次）；左半「攻击者」：提案卡、四段狀態條、倒數（以區塊數顯示）、execute 結果；右半「哨兵」：三張哨兵卡（心跳、判定、否決四段狀態條）；底部：事件串流；大字：「否决用了 X 块／攻击者还要等 Y 块」、單次否決成本（MON 與美元） |
| S2 | AI 報告浮層 | 逐字浮現；顯示 reportHash 與 attachReason tx；模板報告要標「模板」 |
| S3 | 評委出題 | 4 張蓋牌（3 種攻擊＋1 個正常升級），載入時洗牌；選完送提案，判定後翻牌 |
| S4 | 正常升級放行 | 沿用 S1；30 塊後顯示「已生效 v2」，並讀 version() 佐證 |
| S5 | 30 區塊對照表 | 以太坊約 6 分鐘、BSC 約 13.5 秒、Monad 約 10 秒（約 0.33 秒/塊；畫面顯示實測值；也可只放投影片） |

四段狀態條：Proposed → Voted → Finalized → Verified，資料來自 monadNewHeads 的 commitState。本機重演模式沒有這些階段，狀態條改灰色，只顯示「已出块」。

本機服務與埠：anvil 8545；driver 8700；哨兵 8701–8703；reporter 8710；前端 5173；LM Studio 1234。
