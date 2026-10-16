-- 2026-10-16: 學生免登入自由報名（自填 Email 留存，不驗證）。僅新增欄位。
-- activities.login_required = 0 且 fill_mode = 'student' 時，學生不需登入即可報名。
-- registrations.verified = 0 表示 Email 為自填、未經 Google 驗證；cancel_hash 為取消碼的 SHA-256。
-- 執行：npx wrangler d1 execute djhs-activity-db --remote --file=./migrations/0011_open_registration.sql
ALTER TABLE activities ADD COLUMN login_required INTEGER NOT NULL DEFAULT 1 CHECK(login_required IN (0,1));
ALTER TABLE registrations ADD COLUMN verified INTEGER NOT NULL DEFAULT 1 CHECK(verified IN (0,1));
ALTER TABLE registrations ADD COLUMN cancel_hash TEXT;
