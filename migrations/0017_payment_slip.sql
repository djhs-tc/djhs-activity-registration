-- 2026-10-21: 繳費單。pay_due = 繳費期限（YYYY-MM-DD，臺灣日期，可空白）、pay_info = 繳費方式說明。僅新增欄位。
ALTER TABLE activities ADD COLUMN pay_due TEXT NOT NULL DEFAULT '';
ALTER TABLE activities ADD COLUMN pay_info TEXT NOT NULL DEFAULT '';
