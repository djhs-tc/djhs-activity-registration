# 大甲國中｜活動報名管理平台

GitHub Pages 靜態活動資訊入口。網站**不蒐集或儲存報名資料**，僅將教師導向另行部署的 Google Apps Script 網頁應用程式。

## 內容
- `index.html`：自律學習力講座宣傳與報名入口。
- `config.js`：填入已部署並經安全驗證的 GAS `/exec` 網址。未設定時報名按鈕保持停用。

## 啟用
1. 由 `tjjh111@tjjh.tc.edu.tw` 在 Google Apps Script 建立後端並綁定教學組試算表。
2. 實測使用者身分辨識、非管理員禁止抽籤與修改、重複報名與截止時間。
3. 在 `config.js` 設定 GAS 正式 `/exec` 網址。
4. GitHub → Settings → Pages → Source: Deploy from a branch → Branch: `main` → Folder: `/(root)` → Save。

> 注意：GitHub Pages 可能對所有網路使用者公開，請勿在此放置教師名冊、密碼、權杖、個資及後端管理憑證。GitHub Pages 僅是入口，不代表 GAS 後端已完成部署。
