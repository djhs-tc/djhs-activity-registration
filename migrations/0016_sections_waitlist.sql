-- 2026-10-21: 營隊開班與候補。section_size = 營隊每班人數上限（0 = 不分班）、max_sections = 最多開幾班（0 = 不限）、
-- waitlist = 1 表示額滿改候補（超過人數上限仍收件，依報名先後排候補，有人取消或不參加時自動遞補）。僅新增欄位。
ALTER TABLE activities ADD COLUMN section_size INTEGER NOT NULL DEFAULT 0;
ALTER TABLE activities ADD COLUMN max_sections INTEGER NOT NULL DEFAULT 0;
ALTER TABLE activities ADD COLUMN waitlist INTEGER NOT NULL DEFAULT 0 CHECK(waitlist IN (0,1));
