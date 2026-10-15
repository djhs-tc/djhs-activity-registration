-- 2026-10-15: 允許被取消的班級重新報名。
-- 表格層級的 UNIQUE(activity_id, class_code) 改為只限制「未取消」報名的部分唯一索引。
-- SQLite 無法移除表格層級的 UNIQUE，因此重建資料表並複製既有資料。
-- 執行：npx wrangler d1 execute djhs-activity-db --remote --file=./migrations/0002_registrations_allow_reregister.sql
PRAGMA defer_foreign_keys = true;
CREATE TABLE registrations_new (
 id TEXT PRIMARY KEY,
 activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE RESTRICT,
 class_code TEXT NOT NULL,
 teacher_name TEXT NOT NULL,
 teacher_email TEXT NOT NULL,
 accompany TEXT NOT NULL DEFAULT 'pending',
 notes TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('priority','lottery_pool','selected','not_selected','cancelled','pending')),
 submitted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 draw_rank INTEGER
);
INSERT INTO registrations_new (id, activity_id, class_code, teacher_name, teacher_email, accompany, notes, status, submitted_at, draw_rank)
 SELECT id, activity_id, class_code, teacher_name, teacher_email, accompany, notes, status, submitted_at, draw_rank FROM registrations;
DROP TABLE registrations;
ALTER TABLE registrations_new RENAME TO registrations;
CREATE UNIQUE INDEX IF NOT EXISTS uq_reg_active_class ON registrations(activity_id, class_code) WHERE status != 'cancelled';
CREATE INDEX IF NOT EXISTS idx_reg_activity_time ON registrations(activity_id, submitted_at, id);
CREATE INDEX IF NOT EXISTS idx_reg_email ON registrations(teacher_email);
