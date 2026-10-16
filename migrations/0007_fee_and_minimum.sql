-- 2026-10-16: 營隊費用與最低開班人數（全校總人數門檻）。僅新增欄位。
-- 執行：npx wrangler d1 execute djhs-activity-db --remote --file=./migrations/0007_fee_and_minimum.sql
ALTER TABLE activities ADD COLUMN fee INTEGER NOT NULL DEFAULT 0;
ALTER TABLE activities ADD COLUMN min_participants INTEGER NOT NULL DEFAULT 0;
