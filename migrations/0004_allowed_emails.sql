-- 2026-10-16: 個別允許登入的非學校信箱（例如導師慣用的 Gmail），由管理員在後台維護。僅新增資料表。
-- 執行：npx wrangler d1 execute djhs-activity-db --remote --file=./migrations/0004_allowed_emails.sql
CREATE TABLE IF NOT EXISTS allowed_emails (
 email TEXT PRIMARY KEY,
 note TEXT NOT NULL DEFAULT '',
 added_by TEXT NOT NULL,
 added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
