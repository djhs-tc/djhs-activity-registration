# 大甲國中活動報名系統

靜態入口網站透過 GitHub Pages 發布；教師實際報名、管理及抽籤功能由 **Google Apps Script** 提供，資料儲存在教學組 Google 試算表。

## 專案結構
- `index.html`：公開活動資訊入口
- `config.js`：填入經測試的 GAS 網頁部署網址後才啟用按鈕
- `gas/Code.gs`：登入身分驗證、活動建立、報名、抽籤及操作日誌
- `gas/Index.html`：教師報名與管理員頁面
- `gas/appsscript.json`：台灣時區及 Apps Script 設定

## 首次部署（tjjh111@tjjh.tc.edu.tw）
1. 以教學組 Google 帳號開啟 https://script.google.com/home/projects/create，專案名稱設為「DJHS 活動報名系統」。
2. 用此專案的 `gas/Code.gs` 替換 Apps Script 預設 `Code.gs`；新增名為 `Index` 的 HTML 檔案並貼上 `gas/Index.html`。
3. 在 Apps Script 專案設定勾選顯示 `appsscript.json`，並設定時區 Asia/Taipei。
4. 在 Apps Script 編輯器的函式選單執行 **setup** 一次，核准試算表相關授權；它會驗證工作表名稱與標頭，並設定管理員為 `tjjh111@tjjh.tc.edu.tw`。現有試算表連結：https://docs.google.com/spreadsheets/d/1n8HkkuC9BNLvVN9uwRW4iiISgKwFr0j4t-UjvHip3QM/edit
5. 部署 → 新增部署作業 → **網頁應用程式**。執行身分選「我」，存取權限優先限定校方 Workspace 網域（若管理政策提供此選項）。**不要開放匿名訪客。**
6. 取得 `https://script.google.com/macros/s/.../exec` 正式網址。使用管理員帳號測試建立活動，再以校內非管理員帳號測試登入辨識、報名與權限限制。如果 `Session.getActiveUser().getEmail()` 無法辨識使用者，**停止上線，不可降級為匿名報名**。
7. 修改根目錄 `config.js` 的 `gasWebAppUrl`，貼上完成權限與功能驗證的 `/exec` 網址，GitHub Pages 的報名按鈕才會顯示。
8. GitHub Settings → Pages → Deploy from a branch，設定 `main` → `/(root)`。

## 首場活動
管理員在 GAS 報名頁建立活動：
- 名稱：自律學習力
- 講師：陳怡嘉老師（嘉嘉老師）
- 時間：2026-11-12 14:00–16:00
- 地點：鎮瀾文化大樓
- 對象：七、八、九年級
- 優先名額：15；增額抽籤：3
- 報名開始與抽籤截止：由管理員設定

## 安全注意事項
- **GitHub Pages 前端公開**，不儲存報名資料；不在儲存庫加入 Google 金鑰、導師電子郵件名冊或試算表下載檔。
- Google Workspace 身分辨識是否成功依部署環境而異。管理員驗證在 GAS 後端執行；請確保非管理員不能呼叫 `createEvent`、`runLottery`，且無登入身分者無法呼叫 `submitRegistration`。
- `LockService` 保護同時報名，但無法替代防刷、名單確認與備份；正式對全校開放前請完整測試。
- 無須將後端 API 暴露給 GitHub Pages：公開首頁**僅連結**到受保護的 GAS 網頁。這是為了避免跨網域 CORS 與身分驗證問題。
- 更新 GAS 後須在「管理部署」建立新版本，GitHub 更新本身不會自動更新 GAS 正式網站。
- 目前前端不提供自行取消或修改報名，發現錯誤需由管理員審核處理。

## 尚未完成
- GAS 尚未實際安裝、授權及部署
- 校內教師身分辨識及權限測試尚未執行
- 尚未設置正式報名活動及報名截止時間
- GitHub Pages 報名按鈕保持停用，直到填入通過測試的 GAS 網址
