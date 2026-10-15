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
 lottery_at TEXT
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
 draw_rank INTEGER,
 UNIQUE(activity_id, class_code)
);
CREATE INDEX IF NOT EXISTS idx_reg_activity_time ON registrations(activity_id, submitted_at, id);
CREATE INDEX IF NOT EXISTS idx_reg_email ON registrations(teacher_email);
CREATE TABLE IF NOT EXISTS audit_logs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 actor_email TEXT NOT NULL,
 action TEXT NOT NULL,
 activity_id TEXT,
 details_json TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
