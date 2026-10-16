-- 2026-10-16: 每個活動各自指定承辦人（行事曆提醒的邀請對象；日後 Email 通知也寄給此人）。僅新增欄位。
-- 執行：npx wrangler d1 execute djhs-activity-db --remote --file=./migrations/0005_activity_organizer.sql
ALTER TABLE activities ADD COLUMN organizer_name TEXT NOT NULL DEFAULT '';
ALTER TABLE activities ADD COLUMN organizer_email TEXT NOT NULL DEFAULT '';
