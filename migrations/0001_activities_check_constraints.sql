-- 2026-10-15: D1 上的 activities 表是手動建立的，缺少 schema.sql 中的 CHECK 限制。
-- SQLite 無法以 ALTER TABLE 新增 CHECK，因此重建資料表並複製既有資料。
-- 執行：npx wrangler d1 execute djhs-activity-db --remote --file=./migrations/0001_activities_check_constraints.sql
PRAGMA defer_foreign_keys = true;
CREATE TABLE activities_new (
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
INSERT INTO activities_new (id, title, speaker, venue, audience, description, starts_at, ends_at, opens_at, deadline_at, priority_quota, lottery_quota, status, created_by, created_at, lottery_at)
 SELECT id, title, speaker, venue, audience, description, starts_at, ends_at, opens_at, deadline_at, priority_quota, lottery_quota, status, created_by, created_at, lottery_at FROM activities;
DROP TABLE activities;
ALTER TABLE activities_new RENAME TO activities;
