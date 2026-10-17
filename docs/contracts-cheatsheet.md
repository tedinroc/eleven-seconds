# 合約小抄（cast 手動操作）

driver 還沒好之前，操作者可以直接用這份小抄在 anvil 或測試網上操作。介面定義見 `docs/spec.md` 第 3 節。

## 檔案

| 路徑 | 內容 |
|---|---|
| `src/GuardedAdmin.sol` | 冷靜期＋否決＋breakGlass，ProxyAdmin 與代幣（Ownable）的 owner |
| `src/DemoBTC.sol`、`src/DemoBTCV2.sol` | DemoBTC（dBTC，8 位小數）v1 與 v2（多 `version()` 回傳 "2"） |
| `src/PausedImpl.sol` | breakGlass 目標：view 正常，轉帳／mint 一律 `TokenPaused()` |
| `src/attack/` | EvilMintImpl（R1）、EvilOwnerImpl（R2，`claimOwner()`）、EvilFeeImpl（R3，轉帳抽 10% 給 owner）。**示範用惡意碼，不上 Sourcify** |
| `script/Deploy.s.sol` + `script/deploy.sh` | 一鍵部署，輸出 `shared/deployments/<anvil\|10143>.json` |
| `script/measure-gas.sh` | 自開一個拋棄式 anvil（預設 8546）實測 gas，寫 `shared/gas.json` |
| `script/export-shared.sh` | 重新匯出 `shared/abi/*.json` 與 `shared/rules.json` |

`shared/abi/DemoBTC.json` 是 **v2 的 ABI**（v1 的超集合，多一個 `version()`），一份 ABI 就能讀 proxy；proxy 還在 v1 時呼叫 `version()` 會 revert。v1 原樣的 ABI 在 `DemoBTCV1.json`。

## 部署

```bash
# 本機 anvil（帳號 index 0 deployer、1 admin、2/3/4 sentinel1–3、5 approver、6/7/8 holders）
anvil --network monad -b 0.3 --port 8545
RPC_URL=http://127.0.0.1:8545 script/deploy.sh            # 寫 shared/deployments/anvil.json

# 測試網 10143：預設只模擬；BROADCAST=1 才真的送出（由操作者執行）
export DEPLOYER_KEY_FILE=... ADMIN_KEY_FILE=...                # 檔案內容是一行 hex 私鑰
export SENTINEL1_KEY_FILE=... SENTINEL2_KEY_FILE=... SENTINEL3_KEY_FILE=... APPROVER_KEY_FILE=...
#   （或改給 SENTINEL1_ADDR…APPROVER_ADDR 位址；或 KEY_DIR=目錄，檔名 <標籤>.key）
RPC_URL=https://testnet-rpc.monad.xyz script/deploy.sh               # 模擬，輸出到 cache/
RPC_URL=https://testnet-rpc.monad.xyz BROADCAST=1 script/deploy.sh   # 真送，寫 shared/deployments/10143.json
```

- 全新 anvil 上 deployer nonce 從 0 開始，所以位址是固定的；`deployBlock` 會不同。不想覆寫 `anvil.json` 時加 `OUT_JSON=cache/xxx.json`。
- 測試網的 holders 預設是 3 個由雜湊產生、**沒有私鑰**的位址（沒人能動它們的 dBTC；哨兵模擬不驗簽，照樣能從它們轉帳）。要指定就給 `HOLDERS=0xA,0xB,0xC`。
- 只有 deployer 與 admin 會簽交易；admin 只送一筆 `ProxyAdmin.transferOwnership(GuardedAdmin)`（＝導入那一步）。
- BROADCAST=1 到測試網後，腳本會印出 Sourcify 驗證指令（只驗 GuardedAdmin、DemoBTC、DemoBTCV2）。
- 測試網模擬（fork，不送交易）實測：整份部署約 13.2M gas，以當時 max fee 203 gwei 估約 2.69 MON（deployer 注資 10 MON 足夠）。
- 模擬會在 `broadcast/Deploy.s.sol/10143/dry-run/` 留檔，不必提交。

## 環境變數（以下指令共用）

```bash
D=shared/deployments/anvil.json          # 測試網改成 shared/deployments/10143.json
export ETH_RPC_URL=http://127.0.0.1:8545
GA=$(jq -r .guardedAdmin $D); TOKEN=$(jq -r .proxy $D); PA=$(jq -r .proxyAdmin $D)
ADMIN=$(jq -r .owner $D); APPROVER=$(jq -r .approver $D)
S1=$(jq -r '.guardians[0]' $D); S2=$(jq -r '.guardians[1]' $D); S3=$(jq -r '.guardians[2]' $D)
H1=$(jq -r '.holders[0]' $D)
V1=$(jq -r .impls.v1 $D); V2=$(jq -r .impls.v2 $D); PAUSED=$(jq -r .impls.paused $D)
EVIL_MINT=$(jq -r .impls.evilMint $D); EVIL_OWNER=$(jq -r .impls.evilOwner $D); EVIL_FEE=$(jq -r .impls.evilFee $D)
R1=$(jq -r '.rules[] | select(.rule=="R1_TOTAL_SUPPLY").ruleHash' shared/rules.json)
```

簽名方式：anvil 上帳號都已解鎖，用 `--unlocked --from $ADMIN`。測試網上用鑰匙檔，讓私鑰只進那一個行程的環境變數：
`ETH_PRIVATE_KEY="$(tr -d ' \r\n' < "$ADMIN_KEY_FILE")" cast send ...`（不要把私鑰貼在指令列上）。下面一律寫 anvil 版。（zsh 不會拆開未加引號的變數，所以旗標都直接寫出來。）

## 提案：四張卡（全是 proposeUpgrade）

```bash
cast send --unlocked --from $ADMIN $GA "proposeUpgrade(address,bytes)" $V2 0x          # 正常升級 → 哨兵放行
cast send --unlocked --from $ADMIN $GA "proposeUpgrade(address,bytes)" $EVIL_MINT 0x   # T1 無權限 mint → R1 否決
cast send --unlocked --from $ADMIN $GA "proposeUpgrade(address,bytes)" $EVIL_OWNER 0x  # T2 搶 owner → R2 否決
cast send --unlocked --from $ADMIN $GA "proposeUpgrade(address,bytes)" $EVIL_FEE 0x    # T3 轉帳抽成 → R3 否決
```

設定類提案（T4／T5；一樣要等冷靜期、哨兵依 R7 否決）：

```bash
cast send --unlocked --from $ADMIN $GA "proposeSetGuardian(address,bool)" $S3 false   # 拔掉 guardian（value=0）
cast send --unlocked --from $ADMIN $GA "proposeSetDelay(uint64)" 10                    # 縮短延遲（< 10 直接 InvalidDelay）
cast send --unlocked --from $ADMIN $GA "proposeSetPausedImpl(address)" $V2             # 更換暫停實作
```

## 讀狀態

```bash
ID=$(( $(cast call $GA "nextId()(uint256)") - 1 ))     # 最新提案 id（id 從 1 起）
cast call $GA "getProposal(uint256)((uint8,uint8,address,address,uint256,bytes32,bytes32,uint64,uint64,uint256))" $ID
#  欄位：kind, status, proposer, target, value, codehash, dataHash, proposedBlock, readyBlock, vetoCount
#  kind 0 Upgrade 1 SetGuardian 2 SetDelay 3 SetPausedImpl；status 0 None 1 Pending 2 Vetoed 3 Executed
cast block-number
cast call $GA "isWired()(bool)"; cast call $GA "paused()(bool)"; cast call $GA "delayBlocks()(uint64)"
cast implementation $TOKEN       # 目前 impl（讀 ERC-1967 slot）
cast admin $TOKEN                # ProxyAdmin 位址
cast call $PA "owner()(address)" # 應該是 $GA
cast call $TOKEN "owner()(address)" # 代幣 owner 也應該是 $GA（deployments 的 tokenOwner）；admin 直接 mint 會回 OwnableUnauthorizedAccount
cast call $TOKEN "version()(string)"   # v2 才有，v1 會 revert
cast call $TOKEN "balanceOf(address)(uint256)" $H1
```

## 否決、附報告、預核准

```bash
cast send --unlocked --from $S1 $GA "veto(uint256,bytes32)" $ID $R1          # 第 2、3 個哨兵再送：狀態不變、vetoCount 累加
cast send --unlocked --from $S1 $GA "attachReason(uint256,bytes32)" $ID $(cast keccak "报告全文")
cast send --unlocked --from $APPROVER $GA "approveCodehash(bytes32)" $(cast codehash $V2)
```

`approveCodehash` 的參數是 `extcodehash`（`cast codehash`，＝`keccak256(runtime bytecode)`），也就是 `getProposal` 與 `Proposed` 裡的 codehash。

## execute

```bash
cast call $GA "execute(uint256)" $ID          # 先乾跑，看錯誤名稱
cast send --unlocked --from $ADMIN --gas-limit $(jq .execute.gasLimit shared/gas.json) $GA "execute(uint256)" $ID
```

乾跑失敗時 cast 會印出 custom error 的 data，對照下表或用 `cast decode-error <data> --sig "ProposalVetoed(uint256)"`。
已否決的提案送 execute 會在鏈上 revert（給畫面一個 revert tx hash；Monad 照 gas limit 收費）。

| 錯誤 | selector | 何時 |
|---|---|---|
| `ProposalVetoed(uint256)` | `0xde0cea2a` | 對已否決提案 execute（demo 主角） |
| `TooEarly(uint256,uint64,uint64)` | `0x8251b392` | 冷靜期未滿（id, readyBlock, currentBlock） |
| `AlreadyExecuted(uint256)` | `0x6a64e961` | 重複 execute，或 veto 已執行提案 |
| `UnknownProposal(uint256)` | `0x28e0cf5a` | id 不存在 |
| `NotOwner()` / `NotGuardian()` / `NotApprover()` / `NotOwnerOrGuardian()` | `0x30cd7471` / `0xef6d0f02` / `0x65f84cc0` / `0x2c49223e` | 權限不符 |
| `InvalidDelay(uint64)` / `GuardianBounds(uint256)` | `0x2161f0ea` / `0xff6d7c88` | 參數越界 |
| `ZeroAddress()` / `NoCode(address)` / `AlreadyPaused()` | `0xd92e233d` / `0x674520b6` / `0x1785c681` | 其他 |
| `TokenPaused()`（PausedImpl） | `0xe7792495` | breakGlass 後轉帳／mint |
| `OwnableUnauthorizedAccount(address)`（ProxyAdmin） | `0x118cdaa7` | admin EOA 想繞過 GuardedAdmin（T6） |

## breakGlass 與解除

```bash
cast send --unlocked --from $S1 $GA "breakGlass()"     # owner 或任一 guardian；立即切到 PausedImpl
cast send --unlocked --from $H1 $TOKEN "transfer(address,uint256)" $S1 1   # → TokenPaused()
cast send --unlocked --from $ADMIN $GA "proposeUpgrade(address,bytes)" $V2 0x   # 解除＝升級回 v1/v2，一樣等 30 塊；execute 後 paused=false
```

## 事件 topic0

| 事件 | topic0 |
|---|---|
| `Proposed(uint256,uint8,address,uint256,bytes,bytes32,uint64)` | `0x285727720a00ef34ea22137bb6abfbece7a3fdc426dc10fd2455117b813db907` |
| `Vetoed(uint256,address,bytes32,uint256)` | `0xb82755299c0379646a854629c5737dff9564ddbf9f9325181f5a68fd9d7bcd3e` |
| `Executed(uint256,address)` | `0x7271f8b3d48d26ccc839c0f424fe9e12fe4e058108b58c096c078659c7fbadf6` |
| `ReasonAttached(uint256,address,bytes32)` | `0xc1710d8ca78445b27c5c7c7adcacd9f2e4e165e5016f7205b86939f7fe4f0645` |
| `CodehashApproved(bytes32,address)` | `0xfed28e29e604c06e5f8068bc6c735b810b79e25f339bb668b90b4268b3c9bd77` |
| `BrokeGlass(address,address)` | `0x68e7480d983ed258491859cc2c29ff72e9b73fe2a428ce8fddb4e51a4b2507e2` |
| `GuardianSet(address,bool)` | `0xc4459d655e1efe034a75446f1f4db087f75d23bdfabccffafa6384cdb23a1544` |

```bash
cast logs --from-block $(jq .deployBlock $D) --address $GA "Proposed(uint256 indexed,uint8 indexed,address indexed,uint256,bytes,bytes32,uint64)"
```
（測試網的 getLogs 一次最多 100 塊，請改用 `--from-block` 最近的區塊。）

## 與 spec 的小差異（全部是「多出來」的唯讀項，未改任何凍結簽名）

- 多了 view：`owner()`、`getProposalData(uint256)`（提案 data 原文）、`hasVetoed(uint256,address)`、四個常數 getter。
- `veto` 冪等的計數以 guardian 為單位：同一個 guardian 重送不會讓 vetoCount 再加（事件照發），所以 3 個哨兵最多顯示 3/3。
- `getProposal` 回傳一個 tuple（struct），viem 讀出來是具名物件。

## gas（`shared/gas.json`）

`gasLimit = ceil(gasUsed × 1.10)`，gasUsed 取 `_detail` 中各變體的最大值，全部來自 `anvil --network monad` 的真實交易收據（不是模擬，不是估算）。Monad 依 gas limit 收費，所以否決成本＝`veto.gasLimit × effectiveGasPrice`。`execute` 的上限只涵蓋 init data 為空的升級。
