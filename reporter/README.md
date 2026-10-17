# reporter：AI 風險報告（埠 8710）

訂閱 3 個哨兵的 SSE，每個提案收到 `sim_result` 後寫一段 2–3 句的簡體中文風險報告，給人類多簽參考。**報告不影響否決判定**，否決只由哨兵決定。

流程：`sim_result`（3 個哨兵用 proposal id 去重，先等 `AGG_MS` 收齊，有任一否決就以否決為準）→ 程式算好所有數字（totalSupply 變化、轉帳差額與百分比、selector 差異）→ 本機 LM Studio 只負責措辭 → 串流 `report_token` → 算 `keccak256(UTF-8 全文)` → 存 `reports/<id>.json` → `POST` 哨兵 1 的 `/attach`（`{id, reportHash}`）代送 `attachReason`。

## 啟動

```sh
cd reporter
npm install            # 只依賴 viem 2.57.2
npm start              # = node src/reporter.mjs
npm run selftest       # 假 sim_result 事件自測（假哨兵＋假 LM Studio，不碰鏈）
npm run probe-llm      # 對真的 LM Studio 打一次，看首字延遲、tok/s、是否通過檢查
```

本機服務：`GET /events`（SSE）、`GET /health`、`GET /reports`、`GET /reports/<id>`。只綁 127.0.0.1，CORS 開放給前端。

## 模型與降級

- LM Studio OpenAI 相容端點，預設 `/v1/completions`，提示詞用 Qwen 聊天模板手組，assistant 開頭預填空的 `<think>\n\n</think>\n\n` 關閉思考（LM Studio 會靜默丟掉 enable_thinking 這類參數）。`LLM_API=chat` 改用 chat 端點、結尾放預填的 assistant 訊息。
- 模型自動挑 `/v1/models` 裡的 Qwen3.8-27B，也可用 `LLM_MODEL` 指定。取樣用非思考建議值，`max_tokens` 80。
- 啟動時會發一次 1 token 的暖機請求（暖連線、觸發 JIT 載入）；`LLM_WARMUP=0` 關閉。
- **模板報告（`cached: true`）**：LM Studio 沒開、`LLM_FIRST_TOKEN_MS` 內沒出第一個字、總預算 `LLM_TIMEOUT_MS`（20 秒）用完、或依實測速度推算必然超時（提早中止，不必乾等 20 秒），一律改用依規則 ID（R1–R8 與 pass）填空的模板。
- 模型輸出還要過檢查，不過就改用模板：出現「绝对安全」之類的絕對化措辭、推測攻擊者身分、或出現提示詞裡沒有的數字（防幻覺數字）。
- 一次只跑一個生成；排隊時間也算在該報告的 20 秒預算內。

## 事件（spec 4.4，`source: "reporter"`）

| type | 欄位 |
|---|---|
| `report_token` | `id`、`delta`、`cached`；若 LLM 已串了一部分才降級成模板，第一個模板 token 帶 `extra.restart: true`，前端要先清掉已顯示的字 |
| `report_done` | `id`、`text`、`hash`、`cached`；`extra`：`verdict`、`rule`、`model`、`reason`（降級原因）、`genMs` |

`report_done.text` 是唯一權威全文（hash 就是它的 keccak256），前端最後以它為準。

## reports/

`reports/<id>.json`：`text`、`hash`、`cached`、`verdict`、`rule`、`ruleHash`、`facts`（餵給模型的事實清單）、`attach`（代送結果）等。同一 id 再出現（例如本機鏈重開）時舊檔移到 `reports/archive/`，鏈上的 reportHash 永遠能用全文重算。目錄不進 git。

哨兵 1 不在或 `/attach` 失敗：只記在 log 與報告檔的 `attach` 欄位，不重試、不卡住後面的報告。

## 環境變數

| 變數 | 預設 |
|---|---|
| `REPORTER_PORT` | 8710 |
| `SENTINEL_EVENTS` | `http://127.0.0.1:870{1,2,3}/events?backlog=50`（逗號分隔） |
| `ATTACH_URL` | `http://127.0.0.1:8701/attach` |
| `LLM_URL` / `LLM_MODEL` / `LLM_API` | `http://localhost:1234` / 自動 / `completions` |
| `LLM_TIMEOUT_MS` / `LLM_FIRST_TOKEN_MS` / `LLM_MAX_TOKENS` | 20000 / 12000 / 80 |
| `LLM_DISABLE=1` | 一律用模板 |
| `AGG_MS` | 400（收齊 3 個哨兵判定的等待） |
| `STALE_MS` | 30000（忽略啟動前這麼久以前的回放事件） |
| `TOKEN_DECIMALS` / `TOKEN_SYMBOL` | 8 / dBTC |
| `RULES_PATH` | `shared/rules.json`（沒有就用 `keccak256("GUARD/<規則ID>")` 推導） |
