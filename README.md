# 大甲國中活動報名系統

校務活動（講座、研習、營隊）的班級報名平台。首場活動為「自律學習力」講座。

- 正式網址：https://djhs-activity-registration.lunary-02c.workers.dev （`02c` 開頭是**數字 0**）
- 目前狀態：學校 Google 帳號登入、班級報名、管理後台（活動管理／建立活動／報名名單／抽籤作業）皆已上線。

## 架構

```
瀏覽器 ──► Cloudflare Worker「djhs-activity-registration」
            ├─ /api/*  → src/index.js（run_worker_first）──► D1「djhs-activity-db」（binding: DB）
            └─ 其他路徑 → public/ 靜態檔（binding: ASSETS）
GitHub main 推送 ──► Cloudflare Workers Builds（deploy command: npx wrangler deploy）自動部署
```

| 檔案 | 作用 |
|---|---|
| `wrangler.jsonc` | Worker 設定：入口、靜態資源、D1 binding、允許登入的網域 |
| `src/index.js` | API 路由（見下表） |
| `src/auth.js` | Google ID token 驗證（JWKS 簽章、iss、aud、exp、nonce、email_verified、hd 網域）與 session cookie |
| `src/activities.js` | 活動、報名、取消、抽籤與 CSV 的商業邏輯 |
| `src/http.js` | JSON 回應、錯誤、臺灣時間轉換 |
| `public/index.html` | 前端：活動列表（含報名表單）、我的報名、管理後台四個功能區 |
| `public/privacy.html` | 隱私權說明（Google 同意畫面引用） |
| `schema.sql` | D1 完整結構（新環境建表用） |
| `migrations/` | 已對正式 D1 執行過的結構變更紀錄 |
| `tests/` | `npm test`：驗證、權限、報名、同時報名、截止邊界、抽籤（以 `node:sqlite` 執行真正的 SQL，不需安裝套件） |
| `scripts/verify-live.sh` | 線上端到端驗證（只讀） |
| `gas/` | 舊版 Google Apps Script 實作，**僅供參考，未使用** |

### API

| 方法 | 路徑 | 權限 | 說明 |
|---|---|---|---|
| GET | `/api/health` | 公開 | 健康檢查，含 D1 連線測試與登入是否已設定 |
| GET | `/api/activities` | 公開 | 開放中／已關閉／已抽籤且尚未結束的活動，含目前報名班數與伺服器時間 |
| GET | `/api/config` | 公開 | 前端設定：`authEnabled`、`googleClientId` |
| GET | `/api/me` | 公開 | 目前登入者（未登入為 `null`），含 `isAdmin` |
| GET | `/api/auth/nonce` | 公開 | 發給一次性 nonce（HttpOnly cookie，10 分鐘） |
| POST | `/api/auth/google` | 公開 | 以 Google ID token 登入，成功後設定 8 小時 session cookie |
| POST | `/api/auth/logout` | 公開 | 登出 |
| POST | `/api/registrations` | 登入 | 班級報名 `{activity_id, class_code, teacher_name, accompany: yes/no, notes}` |
| GET | `/api/my/registrations` | 登入 | 自己送出的報名與結果 |
| GET / POST | `/api/admin/activities` | 管理員 | 列出全部活動（含各狀態班數）／建立活動（草稿） |
| PUT | `/api/admin/activities/:id` | 管理員 | 修改活動（僅限草稿） |
| POST | `/api/admin/activities/:id/status` | 管理員 | 狀態轉換：草稿→開放、開放→關閉、關閉→開放、草稿／關閉／已抽籤→封存 |
| GET | `/api/admin/activities/:id/registrations` | 管理員 | 報名名單與抽籤紀錄 |
| GET | `/api/admin/activities/:id/registrations.csv` | 管理員 | CSV 匯出（Excel 可直接開啟，已防公式注入） |
| POST | `/api/admin/activities/:id/registrations/:rid/cancel` | 管理員 | 取消某班報名 `{reason}` |
| POST | `/api/admin/activities/:id/draw` | 管理員 | 執行抽籤（截止後、僅一次） |

所有 POST／PUT 必須同源（`Origin` 檢查）且為 `application/json`，否則回 403／415。所有時間以 UTC ISO 字串儲存，畫面與輸入一律為臺灣時間（UTC+8）。

### 報名與抽籤規則
- 活動建立後為**草稿**，僅草稿可修改；管理員按「開放報名」後，教師才能在「開放報名」到「報名截止」之間報名（以伺服器時間為準）。
- 班級代碼為年級 7–9 加班號 01–30（如 `701`）；同一活動同一班級只能報名一次（`UNIQUE(activity_id, class_code)`）。
- **優先錄取**：報名寫入時以單一 SQL 敘述（`INSERT … SELECT`，D1 對同一資料庫序列化寫入）計算目前有效報名數，未滿優先名額即為 `priority`，否則為 `lottery_pool`。同時送出也不會超額。
- **抽籤**：截止後由管理員執行一次。產生 32 bytes 隨機種子，候選班級依 `HMAC-SHA256(種子, 報名 id)` 由小到大排序，取前 N 班為 `selected`，其餘 `not_selected`。種子、候選名單、排序鍵與結果寫入 `audit_logs`，可重算驗證；重複執行（含同時按兩次）只有一次會成功。
- **取消**：只能由管理員取消並填寫原因；取消**不會自動遞補**，被取消的班級也**不能重新報名**（受 UNIQUE 限制），需要時由管理員人工處理。
- 稽核紀錄 `audit_logs`：`login`、`activity_create`、`activity_update`、`activity_status`、`register`、`registration_cancel`、`lottery_draw`。

### D1 資料表
`activities`、`registrations`（`UNIQUE(activity_id, class_code)`）、`audit_logs`，索引 `idx_reg_activity_time`、`idx_reg_email`。登入成功會寫一筆 `audit_logs`（action=`login`）。

## Google 登入設定

登入只接受 Google Workspace 管理的學校帳號：ID token 的 `hd` 必須是 `ALLOWED_EMAIL_DOMAINS` 之一（`wrangler.jsonc`，預設 `st.tc.edu.tw,tjjh.tc.edu.tw`），個人 Gmail 一律拒絕。

目前設定（2026-10-15 完成）：
- Google Cloud 專案 `djhs-activity-registration` → Google Auth Platform：使用者類型「外部」、網頁應用程式用戶端、已授權 JavaScript 來源 `https://djhs-activity-registration.lunary-02c.workers.dev`、授權網域 `lunary-02c.workers.dev`、隱私權政策 `/privacy`。用戶端密鑰不使用，也不要提交到儲存庫。
- Cloudflare Worker → Settings → **Variables and Secrets**（執行時期，**不是** Build 底下的同名區塊），三筆皆為 **Secret** 類型：

| 名稱 | 內容 |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth 用戶端 ID（`…apps.googleusercontent.com`） |
| `SESSION_SECRET` | 至少 32 字元隨機字串 |
| `ADMIN_EMAILS` | 管理員 Email，多位以逗號分隔 |

注意事項：
- 這三項**不要**寫進 `wrangler.jsonc` 的 `vars`：同名的 var 與 secret 會讓部署失敗；控制台上的一般 Text 變數則會在下次部署時被刪除。
- 產生 `SESSION_SECRET`（Windows PowerShell 5.1）：
  ```powershell
  $b = New-Object byte[] 48; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
  ```
  更換 `SESSION_SECRET` 會讓所有人登出，可用於緊急撤銷 session。
- Google 同意畫面在「Testing」狀態時只有測試使用者能登入，正式開放前需 Publish。

## 開發與驗證

```bash
npm test                                         # 單元＋整合測試（node:sqlite 執行 schema.sql 與實際 SQL）
npx wrangler deploy --dry-run                    # 檢查 wrangler 設定與 binding，不會部署
bash scripts/verify-live.sh                      # 線上端到端檢查（只讀）
npx wrangler d1 execute djhs-activity-db --remote --command "SELECT type,name FROM sqlite_master"
```

本機完整測試（不碰正式資料）：建立 `.dev.vars`（已列入 `.gitignore`），內容為 `GOOGLE_CLIENT_ID`、`SESSION_SECRET`、`ADMIN_EMAILS` 的測試值，然後
```bash
npx wrangler d1 execute djhs-activity-db --local --file=./schema.sql
npx wrangler dev --local
```

部署：推送到 `main` 即自動建置。**建置成功不等於服務正常**，每次部署後都要跑 `scripts/verify-live.sh`。
若建置失敗：Cloudflare 控制台 → Worker → Deployments → 失敗那一列的「Build」看記錄；暫時性 API 錯誤（例如 2026-10-15 的 `assets-upload-session ... code: 10013`）可直接在該列「⋯ → Retry build」。

## 上線前測試清單

- [x] `npm test` 全部通過（33 項）
- [x] 本機 `wrangler dev` 端到端：草稿不可報名、優先名額、重複報名、取消、截止前不可抽籤、截止後不可報名、同時抽籤僅一次成功、稽核紀錄筆數正確
- [x] `@st.tc.edu.tw`、`@tjjh.tc.edu.tw` 帳號可登入；個人 Gmail 被拒絕；`audit_logs` 有 login 紀錄
- [ ] `scripts/verify-live.sh` 全部 PASS（每次部署後）
- [ ] 一般教師帳號在「管理後台」顯示無權限
- [ ] 正式站以**測試活動**實際操作一次：建立草稿 → 開放 → 兩個帳號報名 → 名單／CSV → 取消 → 封存
- [ ] 確認「自律學習力」活動內容與時間後再開放報名

## 第一場活動
自律學習力｜講師陳怡嘉老師（嘉嘉老師）｜2026-11-12（四）14:00–16:00｜鎮瀾文化大樓｜七、八、九年級，以班級為單位｜優先 15 班、增額抽籤最多 3 班｜開放報名 2026-10-16（五）08:00｜報名截止 2026-11-06（五）12:00（皆為臺灣時間）。管理後台「建立活動」有「填入自律學習力預設值」按鈕。

## 安全注意事項
- 儲存庫是**公開**的：不提交 client secret、session secret、token、資料庫匯出或教師個資。
- 所有寫入 API 都在後端驗證 session；管理 API 另驗證 `ADMIN_EMAILS`。
- 取消後無法重新報名、也不自動遞補（見「報名與抽籤規則」）；若未來需要，需調整 UNIQUE 限制與遞補規則。
- 舊 Google 試算表資料未與 D1 同步，勿刪除。
