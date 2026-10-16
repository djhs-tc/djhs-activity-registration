# CLAUDE.md — AI 程式助理工作守則

> 給協助維護本系統的 AI 助理（Claude Code 或其他 agent）。**開始任何工作前先讀完本檔、`HANDOVER.md`（操作與帳號）與 `README.md`（技術細節）。**
> 使用者通常是學校行政人員、不是工程師：用**繁體中文**回答，說明要白話，操作步驟要具體（點哪裡、選什麼）。

## 專案速覽

- 大甲國中活動報名平台：https://activity.djhs.workers.dev
- Cloudflare Workers + 靜態資源（`public/`）+ D1（SQLite，`djhs-activity-db`）+ Cron Trigger（每 5 分鐘自動抽籤）
- GitHub `djhs-tc/djhs-activity-registration`，**推送到 `main` 即自動部署**（Workers Builds）
- 後端：`src/index.js`（路由表 `ROUTES`、`scheduled()`）、`src/activities.js`（主要商業邏輯）、`src/auth.js`（Google ID token 驗證、session）、`src/allowlist.js`、`src/settings.js`、`src/http.js`
- 前端：`public/index.html` 單一檔案（內嵌 CSS/JS，字串拼接 HTML，無建置步驟）
- 資料表：`schema.sql`（完整結構）＋ `migrations/NNNN_*.sql`（每次變更一個檔）

## 指令

```bash
npm test                     # node --test，tests/d1-shim.mjs 用 node:sqlite 執行真正的 schema.sql，不需安裝套件
bash scripts/verify-live.sh  # 線上唯讀健康檢查，應全部 PASS
```

## 標準修改流程（不可省略）

1. 修改程式＋**新增或調整測試**，`npm test` 全部通過。
2. 有資料表變更時：
   - 寫 `migrations/NNNN_描述.sql`，同步更新 `schema.sql`。
   - **先在正式 D1 執行 migration，再推送程式**（程式先上線卻讀不到新欄位會壞掉）。
   - 只新增欄位或資料表（`ALTER TABLE ADD COLUMN`、`CREATE TABLE`）可以直接執行。
   - **`DROP`、`DELETE`、重建表這類破壞性操作，由人在 D1 Console 自己執行**：提供 SQL 和說明，不要代為執行。
3. 更新 `README.md`（API 表、規則、測試數），必要時更新 `HANDOVER.md`。
4. commit 並推送到 `main`，等部署完成（可用 `gh api repos/djhs-tc/djhs-activity-registration/commits/<sha>/check-runs` 看「Workers Builds: activity」），再跑 `scripts/verify-live.sh`。
5. 用使用者能懂的話回報：改了什麼、怎麼驗證的、使用者還需要做什麼。

## 安全與隱私（硬性規定）

- 儲存庫是**公開的**：不得 commit 任何密碼、金鑰、Secret、資料庫匯出檔，或師生姓名、信箱、名單。手冊和程式中只寫「在哪裡設定」，不寫值。
- **不讀取 Secret 的值**（`GOOGLE_CLIENT_ID`、`SESSION_SECRET`、`ADMIN_EMAILS`）。只確認名稱與類型存在。Secret 由人在 Cloudflare 介面設定，類型必須是 **Secret**、放在 Variables and Secrets（不是 Build 變數，也不是一般 Text）。
- `GOOGLE_CLIENT_ID` **不要**同時寫在 `wrangler.jsonc` 的 `vars`，否則會和 Secret 衝突，導致部署失敗。
- **管理員權限一律在後端檢查**（`requireAdmin`）。前端隱藏按鈕只是介面，不是權限控管。
- 除了刻意設計的「學生免登入」報名、取消、查詢（`/api/public/*`），不要新增匿名寫入的 API。
- 不要刪除 `gas/` 舊版程式，也不要刪除 Google 試算表的舊資料。
- 對正式資料庫只做必要的查詢；查詢結果含個資時，不要貼進 commit 或公開文件。

## 程式慣例（照著寫）

- **併發安全**：名額、唯一性、空缺檢查都放在**同一個 SQL 敘述**裡（`INSERT … SELECT … WHERE 條件`、`UPDATE … WHERE 條件`）。D1 的 `db.batch([...])` 是一個交易。
- **稽核紀錄**：每個異動都要在同一個 batch 寫 `audit_logs`，用 `… WHERE changes() = 1` 確保只有真的變更時才記錄。
- **抽籤**：以 `lottery_at` 作為鎖，只能成功一次；結果可用種子重算（HMAC-SHA256），不要改成不可稽核的隨機方式。
- **編輯活動**：前端送出 `base`（開啟編輯時的內容）做樂觀鎖。新增可編輯欄位時，要加進 `pick()`、`validateActivity`、INSERT／UPDATE 和前端表單。
- **時間**：資料庫存 UTC ISO 字串；畫面和輸入一律是臺灣時間（`taipeiToUtcIso`、前端 `fmt`）。
- **錯誤**：丟 `HttpError(狀態碼, '給使用者看的中文訊息')`。
- 前端 HTML 都是字串拼接，**使用者輸入一律經過 `esc()`**。
- 新增路由：加進 `src/index.js` 的 `ROUTES`；POST／PUT 會自動做同源檢查（`checkSameOrigin`）。
- 回答與程式註解用繁體中文，與既有風格一致。

## 已知地雷（Windows 環境）

- Git Bash 的 heredoc 和 `node -e "…"` 會吃掉反斜線、展開反引號與 `$`。要修改大段程式碼時，**用檔案編輯工具，或把修補腳本寫成檔案再執行**。
- JS 的 `String.replace(a, b)` 中，`b` 裡的 `$&`、`` $` ``、`$'` 有特殊意義，會把檔案改壞。改用函式：`s.replace(a, () => b)`。
- 前端是一個很長的單行字串檔。修改前先用 `grep -o` 找到確切的片段；修改後用 `new Function(...)` 檢查 `<script>` 語法再推送。

## 需要由人操作的事（AI 不代勞）

- 輸入密碼、登入帳號、設定或查看 Secret 值。
- 在 D1 Console 執行刪除或重建類的 SQL。
- 邀請或移除 Cloudflare、GitHub、Google Cloud 的成員。
- 對外公告（寄信、貼群組）。AI 可以擬好文字，由人發送。

## 系統的重要決定（不要輕易推翻）

- 登入只用 **Google 帳號**（不做密碼、不做信箱登入連結）。學生的 @st.tc.edu.tw 帳號被教育局擋住，所以營隊用「學生免登入」。
- 登入政策目前是「所有 Google 帳號」，可在後台「帳號名單」切換。
- 抽籤預設**手動**；自動抽籤是每個活動的選項。
- 有報名紀錄的活動**不能從介面刪除**，只能取消或封存。
- 曾做過「班級導師名單／我班學生」功能，因多數導師信箱不是 Google 帳號而移除（見 git 歷史）。不要在未與使用者確認的情況下加回。
