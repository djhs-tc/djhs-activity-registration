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
 min_participants INTEGER NOT NULL DEFAULT 0,
 -- 人數上限（全校合計，0 = 不限）與額滿處理：close 額滿即截止；lottery 截止後以學生為單位抽籤
 max_participants INTEGER NOT NULL DEFAULT 0,
 overflow_mode TEXT NOT NULL DEFAULT 'close' CHECK(overflow_mode IN ('close','lottery')),
 -- 營隊填寫方式：teacher 導師以班為單位填名單；student 學生一人一筆
 fill_mode TEXT NOT NULL DEFAULT 'teacher' CHECK(fill_mode IN ('teacher','student')),
 -- 學生填寫時是否需要登入：0 = 免登入自由報名（自填 Email，不驗證）
 login_required INTEGER NOT NULL DEFAULT 1 CHECK(login_required IN (0,1))
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
 -- 填寫人身分：teacher（teacher_name/email 為導師）或 student（teacher_name/email 為學生本人）
 submitter TEXT NOT NULL DEFAULT 'teacher' CHECK(submitter IN ('teacher','student')),
 -- 0 = Email 為免登入自填、未驗證；cancel_hash = 取消碼的 SHA-256（免登入報名用）
 verified INTEGER NOT NULL DEFAULT 1 CHECK(verified IN (0,1)),
 cancel_hash TEXT,
 -- 抽籤後依抽籤序遞補錄取的時間（講座以班為單位）
 backfilled_at TEXT
);
-- 導師填寫：同一活動同一班級只能有一筆「未取消」的報名；取消後可重新報名。
-- 學生填寫：一人一筆，由程式檢查同班同座號、同帳號不重複。
CREATE UNIQUE INDEX IF NOT EXISTS uq_reg_active_class_teacher ON registrations(activity_id, class_code) WHERE status != 'cancelled' AND submitter = 'teacher';
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
 -- 超過名額抽籤的結果（抽籤前為 NULL）
 draw_result TEXT CHECK(draw_result IN ('selected','not_selected')),
 draw_rank INTEGER,
 -- 抽籤後依抽籤序遞補錄取的時間（營隊以學生為單位）
 backfilled_at TEXT,
 -- 已繳費但不參加、未錄取、整班取消或活動取消者，退費後登記
 refunded INTEGER NOT NULL DEFAULT 0 CHECK(refunded IN (0,1)),
 refunded_at TEXT,
 refunded_by TEXT,
 UNIQUE(registration_id, seat_no)
);
CREATE INDEX IF NOT EXISTS idx_students_registration ON registration_students(registration_id);
-- 系統設定：login_policy = school_only（預設，限學校帳號＋名單）| any_google（所有 Google 帳號）
CREATE TABLE IF NOT EXISTS settings (
 key TEXT PRIMARY KEY,
 value TEXT NOT NULL,
 updated_by TEXT NOT NULL DEFAULT '',
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
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
