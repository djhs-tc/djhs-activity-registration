-- 2026-10-16: 營隊可選擇由導師填寫（以班為單位）或學生填寫（一人一筆）。
-- 「同活動同班級只能一筆有效報名」只適用於導師填寫的報名；學生填寫改由程式檢查同班同座號、同帳號不重複。
-- 執行：npx wrangler d1 execute djhs-activity-db --remote --file=./migrations/0010_student_fill_mode.sql
ALTER TABLE activities ADD COLUMN fill_mode TEXT NOT NULL DEFAULT 'teacher' CHECK(fill_mode IN ('teacher','student'));
ALTER TABLE registrations ADD COLUMN submitter TEXT NOT NULL DEFAULT 'teacher' CHECK(submitter IN ('teacher','student'));
CREATE UNIQUE INDEX IF NOT EXISTS uq_reg_active_class_teacher ON registrations(activity_id, class_code) WHERE status != 'cancelled' AND submitter = 'teacher';
DROP INDEX IF EXISTS uq_reg_active_class;
