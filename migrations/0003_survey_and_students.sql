-- 2026-10-16: 新增「營隊意願調查」活動類型與學生名單（僅新增，不修改既有資料）。
-- 執行：npx wrangler d1 execute djhs-activity-db --remote --file=./migrations/0003_survey_and_students.sql
ALTER TABLE activities ADD COLUMN kind TEXT NOT NULL DEFAULT 'lecture' CHECK(kind IN ('lecture','survey'));
ALTER TABLE activities ADD COLUMN max_students_per_class INTEGER;
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
