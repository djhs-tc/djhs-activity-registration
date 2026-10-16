-- 2026-10-16: 營隊人數上限與額滿處理方式（額滿即截止／超過名額改抽籤，以學生為單位）。僅新增欄位。
-- 執行：npx wrangler d1 execute djhs-activity-db --remote --file=./migrations/0008_capacity.sql
ALTER TABLE activities ADD COLUMN max_participants INTEGER NOT NULL DEFAULT 0;
ALTER TABLE activities ADD COLUMN overflow_mode TEXT NOT NULL DEFAULT 'close' CHECK(overflow_mode IN ('close','lottery'));
ALTER TABLE registration_students ADD COLUMN draw_result TEXT CHECK(draw_result IN ('selected','not_selected'));
ALTER TABLE registration_students ADD COLUMN draw_rank INTEGER;
