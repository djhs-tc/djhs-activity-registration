-- 2026-11-03: 開放年級與講座補報名。allowed_grades：'' = 不限，否則如 '89'；supplement_at：抽籤後補報名的報名時間。僅新增欄位。
ALTER TABLE activities ADD COLUMN allowed_grades TEXT NOT NULL DEFAULT '';
ALTER TABLE registrations ADD COLUMN supplement_at TEXT;
