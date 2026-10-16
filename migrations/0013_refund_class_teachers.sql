-- 2026-10-16: 退費登記與班級導師名單。僅新增欄位與資料表。
-- 執行：npx wrangler d1 execute djhs-activity-db --remote --file=./migrations/0013_refund_class_teachers.sql
ALTER TABLE registration_students ADD COLUMN refunded INTEGER NOT NULL DEFAULT 0 CHECK(refunded IN (0,1));
ALTER TABLE registration_students ADD COLUMN refunded_at TEXT;
ALTER TABLE registration_students ADD COLUMN refunded_by TEXT;
CREATE TABLE IF NOT EXISTS class_teachers (
 class_code TEXT PRIMARY KEY,
 teacher_name TEXT NOT NULL,
 teacher_email TEXT NOT NULL,
 updated_by TEXT NOT NULL,
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_class_teachers_email ON class_teachers(teacher_email);
