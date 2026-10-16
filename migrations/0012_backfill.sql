-- 2026-10-16: 抽籤後手動遞補（依抽籤序）。記錄遞補時間，用於顯示「錄取（遞補）」。僅新增欄位。
-- 執行：npx wrangler d1 execute djhs-activity-db --remote --file=./migrations/0012_backfill.sql
ALTER TABLE registrations ADD COLUMN backfilled_at TEXT;
ALTER TABLE registration_students ADD COLUMN backfilled_at TEXT;
