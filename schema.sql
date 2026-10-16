-- DJHS activity registration database — Cloudflare D1 / SQLite
-- Apply once in D1 Console or via: npx wrangler d1 execute djhs-activity-db --remote --file=./schema.sql
CREATE TABLE IF NOT EXISTS activities (
 id TEXT PRIMARY KEY,
 title TEXT NOT NULL,
 speaker TEXT NOT NULL DEFAULT '',
 venue TEXT NOT NULL DEFAULT '',
 audience TEXT NOT NULL DEFAULT '',
 description TEXT NOT NULL DEFAULT '',
 starts_at TEXT NOT NULL,
 ends_at TEXT NOT NULL,
 opens_at TEXT NOT NULL,
 deadline_at TEXT NOT NULL,
 priority_quota INTEGER NOT NULL DEFAULT 15 CHECK(priority_quota >= 0),
 lottery_quota INTEGER NOT NULL DEFAULT 3 CHECK(lottery_quota >= 0),
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','open','closed','drawn','archived')),
 created_by TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 lottery_at TEXT,
 -- lecture：講座（優先名額＋抽籤）；survey：營隊意願調查（無名額，收學生名單）
 kind TEXT NOT NULL DEFAULT 'lecture' CHECK(kind IN ('lecture','survey')),
 max_students_per_class INTEGER,
 -- 承辦人（姓名公開顯示；信箱僅管理員可見，作為行事曆邀請／通知對象）
 organizer_name TEXT NOT NULL DEFAULT '',
 organizer_email TEXT NOT NULL DEFAULT '',
 -- 臨時取消：保留報名資料，公開顯示「活動取消」與原因
 cancelled_at TEXT,
 cancel_reason TEXT NOT NULL DEFAULT '',
 -- 營隊意願調查：每人費用（0 = 免費）與最低開班人數（全校總人數，0 = 不限）
 fee INTEGER NOT NULL DEFAULT 0,
 min_participants INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS registrations (
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
-- 同一活動同一班級只能有一筆「未取消」的報名；取消後可重新報名。
CREATE UNIQUE INDEX IF NOT EXISTS uq_reg_active_class ON registrations(activity_id, class_code) WHERE status != 'cancelled';
CREATE INDEX IF NOT EXISTS idx_reg_activity_time ON registrations(activity_id, submitted_at, id);
CREATE INDEX IF NOT EXISTS idx_reg_email ON registrations(teacher_email);
-- 意願調查的學生名單（個資：僅送出的導師與管理員可見）
CREATE TABLE IF NOT EXISTS registration_students (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 registration_id TEXT NOT NULL REFERENCES registrations(id) ON DELETE RESTRICT,
 seat_no INTEGER NOT NULL CHECK(seat_no BETWEEN 1 AND 60),
 name TEXT NOT NULL,
 gender TEXT NOT NULL CHECK(gender IN ('M','F')),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','withdrawn')),
 withdrawn_at TEXT,
 withdrawn_by TEXT,
 paid INTEGER NOT NULL DEFAULT 0 CHECK(paid IN (0,1)),
 paid_at TEXT,
 paid_by TEXT,
 UNIQUE(registration_id, seat_no)
);
CREATE INDEX IF NOT EXISTS idx_students_registration ON registration_students(registration_id);
-- 個別允許登入的非學校信箱（學校網域帳號不需加入）
CREATE TABLE IF NOT EXISTS allowed_emails (
 email TEXT PRIMARY KEY,
 note TEXT NOT NULL DEFAULT '',
 added_by TEXT NOT NULL,
 added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS audit_logs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 actor_email TEXT NOT NULL,
 action TEXT NOT NULL,
 activity_id TEXT,
 details_json TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
