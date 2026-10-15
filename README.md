# 大甲國中活動報名系統

校務活動（講座、研習、營隊）的班級報名平台。首場活動為「自律學習力」講座。

- 正式網址：https://djhs-activity-registration.lunary-02c.workers.dev （`02c` 開頭是**數字 0**）
- 目前狀態：**只讀**。可查看活動，Google 登入程式已部署但需完成設定；**報名、抽籤、管理寫入 API 尚未開放**。

## 架構

```
瀏覽器 ──► Cloudflare Worker「djhs-activity-registration」
            ├─ /api/*  → src/index.js（run_worker_first）──► D1「djhs-activity-db」（binding: DB）
            └─ 其他路徑 → public/ 靜態檔（binding: ASSETS）
GitHub main 推送 ──► Cloudflare Workers Builds（deploy command: npx wrangler deploy）自動部署
```

| 檔案 | 作用 |
|---|---|
| `wrangler.jsonc` | Worker 設定：入口、靜態資源、D1 binding、公開環境變數 |
| `src/index.js` | API 路由（見下表） |
| `src/auth.js` | Google ID token 驗證（JWKS 簽章、iss、aud、exp、nonce、email_verified、hd 網域）與 session cookie |
| `public/index.html` | 前端：活動列表、我的報名、管理後台三分頁 |
| `schema.sql` | D1 完整結構（新環境建表用） |
| `migrations/` | 已對正式 D1 執行過的結構變更紀錄 |
| `tests/` | `npm test` 單元測試（不需安裝套件） |
| `scripts/verify-live.sh` | 線上端到端驗證（只讀） |
| `gas/` | 舊版 Google Apps Script 實作，**僅供參考，未使用** |

### API

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/health` | 健康檢查，含 D1 連線測試與登入是否已設定 |
| GET | `/api/activities` | 狀態為 `open` 的活動 |
| GET | `/api/config` | 前端設定：`authEnabled`、`googleClientId` |
| GET | `/api/me` | 目前登入者（未登入為 `null`），含 `isAdmin` |
| GET | `/api/auth/nonce` | 發給一次性 nonce（HttpOnly cookie，10 分鐘） |
| POST | `/api/auth/google` | 以 Google ID token 登入，成功後設定 8 小時 session cookie |
| POST | `/api/auth/logout` | 登出 |

所有 POST 必須同源（`Origin` 檢查）且為 `application/json`，否則回 403／415。

### D1 資料表
`activities`、`registrations`（`UNIQUE(activity_id, class_code)`）、`audit_logs`，索引 `idx_reg_activity_time`、`idx_reg_email`。登入成功會寫一筆 `audit_logs`（action=`login`）。

## Google 登入設定（尚待完成）

登入只接受 Google Workspace 管理的學校帳號：ID token 的 `hd` 必須是 `ALLOWED_EMAIL_DOMAINS` 之一（預設 `st.tc.edu.tw,tjjh.tc.edu.tw`），個人 Gmail 一律拒絕。以下三項全部設定後，登入才會啟用：

1. **建立 OAuth Client**（需學校或個人 Google 帳號操作）
   1. https://console.cloud.google.com/ 建立專案 → 「API 和服務」→「OAuth 同意畫面」：使用者類型選「外部」，填應用程式名稱與聯絡信箱，範圍只需 `openid`、`email`、`profile`。
   2. 「憑證」→「建立憑證」→「OAuth 用戶端 ID」→ 類型「網頁應用程式」。
   3. 「已授權的 JavaScript 來源」填 `https://djhs-activity-registration.lunary-02c.workers.dev`（不需要重新導向 URI）。
   4. 複製「用戶端 ID」（`…apps.googleusercontent.com`）。**用戶端密鑰不需要，也不要提交到儲存庫。**
   5. 同意畫面若在「測試」狀態，只有測試使用者能登入；正式開放前改為「發布」。
2. **填入 Client ID**：修改 `wrangler.jsonc` 的 `vars.GOOGLE_CLIENT_ID`，推送到 GitHub。Client ID 是公開資訊。
3. **設定機密**（不會出現在儲存庫）：
   ```bash
   npx wrangler secret put SESSION_SECRET   # 貼上至少 32 字元的隨機字串，例如 openssl rand -base64 48 的輸出
   npx wrangler secret put ADMIN_EMAILS     # 例如 tjjh111@tjjh.tc.edu.tw，多位以逗號分隔
   ```
   也可以在 Cloudflare 控制台 → Worker → Settings → Variables and Secrets 以 **Secret** 類型新增。
   注意：`wrangler.jsonc` 的 `vars` 會在每次部署時覆蓋控制台上同名的一般變數，所以公開設定請改檔案，機密一律用 Secret。

## 開發與驗證

```bash
npm test                                         # 單元測試：token 驗證、session、路由、同源檢查
npx wrangler deploy --dry-run                    # 檢查 wrangler 設定與 binding，不會部署
bash scripts/verify-live.sh                      # 線上端到端檢查（只讀）
npx wrangler d1 execute djhs-activity-db --remote --command "SELECT type,name FROM sqlite_master"
```

部署：推送到 `main` 即自動建置。**建置成功不等於服務正常**，每次部署後都要跑 `scripts/verify-live.sh`。
若建置失敗：Cloudflare 控制台 → Worker → Deployments → 失敗那一列的「Build」看記錄；暫時性 API 錯誤（例如 2026-10-15 的 `assets-upload-session ... code: 10013`）可直接在該列「⋯ → Retry build」。

## 上線前測試清單

- [ ] `npm test` 全部通過
- [ ] `scripts/verify-live.sh` 全部 PASS
- [ ] `@st.tc.edu.tw` 教師帳號可登入，「我的報名」顯示正確身分
- [ ] `@tjjh.tc.edu.tw` 管理員帳號登入後「管理後台」顯示管理員
- [ ] 一般教師帳號在「管理後台」顯示無權限
- [ ] 個人 Gmail 帳號被拒絕並顯示網域提示
- [ ] 登出後 `/api/me` 回 `user:null`
- [ ] D1 `audit_logs` 有對應的 login 紀錄
- [ ] （報名功能完成後）多班同時報名、同班重複報名、截止時間前後、第 15／16 班邊界、抽籤只能執行一次

## 第一場活動
自律學習力｜講師陳怡嘉老師（嘉嘉老師）｜2026-11-12（四）14:00–16:00｜鎮瀾文化大樓｜七、八、九年級，以班級為單位｜優先 15 班、增額抽籤最多 3 班。開放報名與抽籤截止時間待管理員確認。

## 安全注意事項
- 儲存庫是**公開**的：不提交 client secret、session secret、token、資料庫匯出或教師個資。
- 尚未開放任何報名、抽籤或管理寫入 API；新增時必須後端驗證 session 與管理員身分。
- `UNIQUE(activity_id, class_code)` 代表取消後無法直接重新報名，需另行設計。
- 舊 Google 試算表資料未與 D1 同步，勿刪除。
