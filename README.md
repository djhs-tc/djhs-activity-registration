# 大甲國中活動報名系統

校務活動（講座、研習、營隊）的班級報名平台。首場活動為「自律學習力」講座。

- 正式網址：https://activity.djhs.workers.dev （2026-10-16 起；舊網址 `djhs-activity-registration.lunary-02c.workers.dev` 已停用）
- 目前狀態：學校 Google 帳號登入、班級報名（講座：優先錄取＋抽籤；營隊意願調查：學生名單＋男女統計＋繳費登記）、管理後台皆已上線。

## 架構

```
瀏覽器 ──► Cloudflare Worker「activity」
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
| `public/index.html` | 前端：首頁資訊看板；活動列表（列表／圖文／月曆檢視）、我的報名、管理後台（活動管理可切換卡片／表格，表格可排序與搜尋） |
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
| POST | `/api/registrations` | 登入 | 班級報名 `{activity_id, class_code, teacher_name, accompany: yes/no, notes, students?}`（意願調查須附學生名單） |
| GET | `/api/my/registrations` | 登入 | 自己送出的報名與結果 |
| GET / POST | `/api/admin/activities` | 管理員 | 列出全部活動（含各狀態班數）／建立活動（草稿） |
| PUT | `/api/admin/activities/:id` | 管理員 | 修改活動（抽籤前皆可；修改後依報名順序重新計算優先錄取） |
| POST | `/api/admin/activities/:id/status` | 管理員 | 狀態轉換：草稿→開放、開放→關閉、關閉→開放、草稿／關閉／已抽籤→封存 |
| POST | `/api/admin/activities/:id/cancel` | 管理員 | 臨時取消活動 `{reason}`：停止報名、保留報名資料、公開顯示原因；不可復原 |
| POST | `/api/admin/activities/:id/delete` | 管理員 | 刪除活動：僅限從未有任何報名紀錄者，內容存入稽核紀錄 |
| GET | `/api/admin/activities/:id/registrations` | 管理員 | 報名名單與抽籤紀錄 |
| GET | `/api/admin/activities/:id/registrations.csv` | 管理員 | CSV 匯出（Excel 可直接開啟，已防公式注入） |
| POST | `/api/admin/activities/:id/registrations/:rid/cancel` | 管理員 | 取消某班報名 `{reason}` |
| GET | `/api/admin/activities/:id/calendar.ics` | 管理員 | 行事曆檔：開放報名、報名截止、活動當天三個事件，內建前 1 天／前 1 小時提醒，承辦人列為與會者 |
| POST | `/api/admin/activities/:id/draw` | 管理員 | 執行抽籤（截止後、僅一次；意願調查不適用） |
| POST | `/api/admin/activities/:id/backfill` | 管理員 | 抽籤後手動遞補：依抽籤序錄取下一位未錄取者（一次一位，需有空缺） |
| POST | `/api/registrations/:rid/students/:sid/withdraw` | 導師（自己的報名、截止前）／管理員 | 意願調查：標記學生不參加 |
| POST | `/api/admin/registrations/:rid/students/:sid/restore` | 管理員 | 恢復學生為參加 |
| POST | `/api/admin/registrations/:rid/students/:sid/paid` | 管理員 | 登記繳費 `{paid: true/false}`（已退費者不能改回未繳） |
| POST | `/api/admin/registrations/:rid/students/:sid/refund` | 管理員 | 登記退費 `{refunded: true/false}`（限已繳且不參加／未錄取／已取消者） |
| GET | `/api/admin/class-teachers` | 管理員 | 班級導師名單 |
| POST | `/api/admin/class-teachers/batch` | 管理員 | 批次設定 `{entries:[{class_code, teacher_name, teacher_email}]}`（整批檢查，同班改派） |
| POST | `/api/admin/class-teachers/remove` | 管理員 | 移除 `{class_code}` |
| GET / POST | `/api/admin/settings` | 管理員 | 讀取／設定登入政策 `{login_policy}`，值為 `school_only` 或 `any_google` |
| GET / POST | `/api/admin/allowed-emails` | 管理員 | 帳號名單：列出／加入個人信箱 `{email, note}` |
| POST | `/api/admin/allowed-emails/batch` | 管理員 | 批次加入 `{entries: [{email, note}]}`，最多 300 筆；任一筆有誤整批不加入，已存在者略過 |
| POST | `/api/admin/allowed-emails/remove` | 管理員 | 從帳號名單移除 `{email}`（立即失效） |

所有 POST／PUT 必須同源（`Origin` 檢查）且為 `application/json`，否則回 403／415。所有時間以 UTC ISO 字串儲存，畫面與輸入一律為臺灣時間（UTC+8）。

### 報名與抽籤規則
- 活動建立後為**草稿**；管理員按「開放報名」後，教師才能在「開放報名」到「報名截止」之間報名（以伺服器時間為準）。**抽籤前**（含開放後）活動內容、時間與名額都可以修改；抽籤後鎖定。
- 班級代碼為年級 7–9 加班號 01–30（如 `701`）；同一活動同一班級只能有**一筆未取消**的報名（部分唯一索引 `uq_reg_active_class`）。
- **優先錄取**：報名寫入時以單一 SQL 敘述（`INSERT … SELECT`，D1 對同一資料庫序列化寫入）計算目前有效報名數，未滿優先名額即為 `priority`，否則為 `lottery_pool`。同時送出也不會超額。
- **抽籤**：報名截止時間已到，或管理員已提前「關閉報名」後，由管理員執行一次。產生 32 bytes 隨機種子，候選班級依 `HMAC-SHA256(種子, 報名 id)` 由小到大排序，取前 N 班為 `selected`，其餘 `not_selected`。種子、候選名單、排序鍵與結果寫入 `audit_logs`，可重算驗證；重複執行（含同時按兩次）只有一次會成功。
- **抽籤前的單一規則**：有效報名（優先錄取＋抽籤候選）依送出時間排序，前 N 班為優先錄取。因此：
  - **取消**：只能由管理員取消並填寫原因；抽籤候選中最早報名的班級**自動遞補**為優先錄取。被取消的班級**可以重新報名**，排在最後。
  - **修改名額**：依同一規則重新計算；調低名額時，較晚報名的優先錄取班級會改為抽籤候選（畫面會先確認）。
  - 每次狀態異動都寫入 `priority_recompute` 稽核紀錄（班級、原狀態、新狀態）。
  - 抽籤後取消不會重新計算。
- **抽籤後手動遞補**：錄取者不參加時，管理員先取消該班（講座）或將學生標記不參加（營隊），「抽籤作業」會顯示空缺數與依抽籤序的下一位，按「遞補下一位」並確認後錄取。空缺＝講座「優先＋抽籤名額 − 優先錄取與抽籤錄取班數」、營隊「人數上限 − 錄取且參加的學生數」。空缺檢查與更新在同一個 SQL 敘述內，同時按兩次也只會遞補一位。遞補者在名單、「我的報名」與 CSV 標示「錄取（遞補）」，稽核紀錄 `lottery_backfill`。名額已被遞補後，原錄取學生不能再「恢復參加」（避免超過上限）。
- 稽核紀錄 `audit_logs`：`login`、`activity_create`、`activity_update`（含修改前後）、`activity_status`、`register`、`registration_cancel`、`priority_recompute`、`lottery_draw`、`lottery_backfill`、`student_withdraw`、`student_restore`、`student_paid`、`student_unpaid`、`student_refunded`、`student_unrefunded`、`class_teacher_set`、`class_teacher_remove`、`allowlist_add`、`allowlist_remove`。

### 取消與刪除活動
- **取消活動**（臨時不辦）：需填原因（公開顯示）。開放中改為關閉並停止報名；所有報名資料保留，導師在「我的報名」看到「活動已取消：原因」。取消後不可編輯、重新開放或抽籤，可再封存。稽核紀錄 `activity_cancel` 記下原因與當時有效報名數。系統不會自動通知導師，請另行通知。
- **刪除活動**（建錯或測試）：只有從未有任何報名紀錄（含已取消的報名）的活動才能刪除；刪除前活動內容存入稽核紀錄 `activity_delete`。

### 承辦人與行事曆提醒
- 每個活動必填**承辦人姓名與信箱**。姓名顯示在公開活動頁；信箱只有管理員可見（公開 API 不回傳）。
- 管理後台「活動管理」每個活動有「加入 Google 日曆」按鈕（開放報名／報名截止／活動當天），已預先把承辦人加為邀請對象；在 Google 日曆儲存並傳送邀請後，承辦人即收到通知並由日曆提醒。也可下載 `.ics`（內建前 1 天與前 1 小時提醒）。
- 截止事件的說明依活動類型提示下一步（講座：執行抽籤；意願調查：統計人數與收費）。修改活動時間後需重新加入行事曆。
- 目前系統本身不寄信：Cloudflare 寄信需要自有網域（現用 `workers.dev`）。日後若購買網域，可改為定時自動寄送附報名人數的 Email 給承辦人。

### 營隊意願調查（`kind = survey`）
- 建立活動時選擇類型，**建立後不可變更**。沒有名額與抽籤，班級報名狀態為「已登記」；每班人數上限由管理員設定（1–60，抽籤前可修改）。
- **填寫方式**（建立營隊時設定，已有報名後不可切換）：
  - **導師填寫**：導師以班為單位貼上全班參加名單（同活動同班級僅一筆有效報名，部分唯一索引 `uq_reg_active_class_teacher`）。
  - **學生填寫**：學生用自己的 Google 帳號一人一筆填寫班級、座號、姓名、性別（`registrations.submitter = student`，`teacher_name/email` 存學生本人）。同帳號、同班同座號不可重複，每班人數上限以該班已報名學生數計算，皆在單一 SQL 敘述中檢查。學生在報名截止前可在「我的報名」自行取消並重新報名（`POST /api/registrations/:rid/cancel`）。系統不知道導師與班級的對應，學生名單由管理員查看。
  - **學生填寫・免登入**（`fill_mode = student` 且 `login_required = 0`）：學生不需登入，填寫班級、座號、姓名、性別與 Email（僅檢查格式，不驗證，`registrations.verified = 0`，管理名單標示「信箱未驗證」）。同 Email、同班同座號不可重複；表單含隱藏陷阱欄位擋簡單機器人。截止前以報名時的 Email＋班級＋座號取消（知道這三項者皆可取消，屬便利性取捨）（`POST /api/public/registrations`、`POST /api/public/registrations/cancel`）。
- 「成團門檻」指營隊能否開辦的全校人數門檻，與報名班數無關。
- 導師報名時填學生名單（座號、姓名、性別），可從 Excel 直接複製三欄貼上，送出前預覽並顯示男女人數。人數一律由名單加總，不另外填寫。
- 送出後**不能新增學生**；送出的導師在**報名截止前**可把個別學生標記為「不參加」，截止後只有管理員可調整。管理員可恢復參加、登記繳費，並可取消整班（取消後該班可重新報名）。
- **費用**（每人，0 = 免費）與**最低開班人數**（全校合計，0 = 不限）由管理員設定。活動頁顯示「材料費 N 元／免費」與開班門檻進度（還差幾人／已達開班人數）。免費活動隱藏所有繳費欄位，CSV 繳費欄顯示「免費」。
- **人數上限**（全校合計，0 = 不限）與**額滿處理**：
  - **額滿即截止**：報名以單一 SQL 敘述檢查「目前有效學生數 + 本次名單 ≤ 上限」，同時送出也不會超額；名額不足時回報剩餘人數。學生標記不參加會釋出名額。活動頁顯示「剩 N 人／已額滿」，額滿時停止報名。
  - **超過名額改抽籤**（必須同時設定人數上限）：截止前不限人數收件；截止後管理員在「抽籤作業」以**學生為單位**抽出上限人數（HMAC-SHA256(種子, "student:" + 學生 id) 排序，種子與名單寫入稽核紀錄，可重算驗證，只能抽一次）。未超過上限時全部錄取。抽籤結果顯示在「我的報名」、管理後台與 CSV，應收金額只計錄取者。
- 管理後台「報名名單」顯示各年級 × 男女人數統計與已繳費人數，CSV 一位學生一列，供收費對帳。
- **退費**：已繳費、但之後不參加、未錄取、整班取消或活動取消的學生列在「退費」區（待退費），退款後勾「已退費」。「已收」＝已繳未退費者；CSV 繳費欄顯示 已繳／已繳（待退費）／已退費／未繳。稽核紀錄 `student_refunded`／`student_unrefunded`。
- **班級導師名單**（管理後台「班級導師」，可從 Excel 貼上 班級、姓名、信箱）：目前**僅保存備用**，不限制報名，也不顯示給導師（「我班學生」查看功能因多數導師信箱不是 Google 帳號而暫停，見 git 歷史 6ef82d5）。稽核紀錄 `class_teacher_set`／`class_teacher_remove`。
- 個資：學生名單只有送出的導師本人與管理員可見；公開 API 只回傳班數與男女總數。

### D1 資料表
`activities`（`kind`：`lecture` 講座／`survey` 營隊意願調查；`max_students_per_class`）、`registrations`（部分唯一索引 `uq_reg_active_class`：同活動同班級僅一筆未取消報名）、`registration_students`（意願調查學生名單：座號、姓名、性別、參加／不參加、繳費）、`audit_logs`。結構變更見 `migrations/`（依序執行，0003 須在部署讀取 `kind` 的程式之前完成）。

## Google 登入設定

**登入政策**（管理後台「帳號名單」最上方切換，存於 `settings` 資料表，切換寫入稽核紀錄 `login_policy`）：
- `school_only`（預設）：只限下列兩種帳號。
- `any_google`：所有已驗證信箱的 Google 帳號皆可登入報名；管理名單中以「個人帳號」標示非學校網域的報名，方便清理。切回 `school_only` 時，個人帳號（不在名單者）立即失效。

`school_only` 時接受兩種帳號：
1. **學校帳號**：Google Workspace 管理的帳號，ID token 的 `hd` 必須是 `ALLOWED_EMAIL_DOMAINS` 之一（`wrangler.jsonc`，預設 `st.tc.edu.tw,tjjh.tc.edu.tw`）。
2. **帳號名單上的個人信箱**：管理後台「帳號名單」加入的信箱（例如導師慣用的 Gmail，必須是 Google 帳號）。非學校帳號每次請求都重新檢查名單，移除後立即失效（即使 session cookie 仍有效）。不在名單上的個人帳號一律拒絕。

目前設定（2026-10-15 完成）：
- Google Cloud 專案 `djhs-activity-registration` → Google Auth Platform：使用者類型「外部」、網頁應用程式用戶端、已授權 JavaScript 來源 `https://activity.djhs.workers.dev`、授權網域 `djhs.workers.dev`、隱私權政策 `/privacy`。用戶端密鑰不使用，也不要提交到儲存庫。
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

- [x] `npm test` 全部通過（75 項）
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
- 取消可遞補、可重新報名；抽籤後鎖定活動時間與名額（見「報名與抽籤規則」）。
- 舊 Google 試算表資料未與 D1 同步，勿刪除。
