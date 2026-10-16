-- 2026-10-16: 系統設定（目前用於登入政策：school_only 限學校帳號＋名單；any_google 所有 Google 帳號）。僅新增資料表。
-- 執行：npx wrangler d1 execute djhs-activity-db --remote --file=./migrations/0009_settings.sql
CREATE TABLE IF NOT EXISTS settings (
 key TEXT PRIMARY KEY,
 value TEXT NOT NULL,
 updated_by TEXT NOT NULL DEFAULT '',
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
