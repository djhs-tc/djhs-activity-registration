-- 2026-10-16: 活動臨時取消（保留報名資料，公開顯示「活動取消」與原因）。僅新增欄位。
-- 執行：npx wrangler d1 execute djhs-activity-db --remote --file=./migrations/0006_activity_cancel.sql
ALTER TABLE activities ADD COLUMN cancelled_at TEXT;
ALTER TABLE activities ADD COLUMN cancel_reason TEXT NOT NULL DEFAULT '';
