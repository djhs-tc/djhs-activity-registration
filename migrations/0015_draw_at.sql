-- 2026-10-16: 自動抽籤時間（NULL = 手動抽籤）。僅新增欄位。
-- 執行：npx wrangler d1 execute djhs-activity-db --remote --file=./migrations/0015_draw_at.sql
ALTER TABLE activities ADD COLUMN draw_at TEXT;
