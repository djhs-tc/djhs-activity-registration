import { HttpError, taipeiToUtcIso, nowIso } from './http.js';

const ACTIVITY_COLUMNS = 'id, title, speaker, venue, audience, description, starts_at, ends_at, opens_at, deadline_at, priority_quota, lottery_quota, status, lottery_at, kind, max_students_per_class';
const ACTIVE = "status != 'cancelled'";
// 班級代碼：年級 7–9 + 班號 01–30，例如 701、815。
export const CLASS_CODE = /^[789](0[1-9]|[12]\d|30)$/;
const ACCOMPANY = ['yes', 'no'];
const GENDER = { '男': 'M', '女': 'F', M: 'M', F: 'F', m: 'M', f: 'F' };
// 意願調查的有效學生數：未取消的報名中、未標記不參加的學生
const studentCount = (alias, extra = '') => `(SELECT COUNT(*) FROM registration_students s JOIN registrations r ON r.id = s.registration_id
  WHERE r.activity_id = ${alias}.id AND r.status != 'cancelled' AND s.status = 'active'${extra})`;
const STUDENT_COUNTS = alias => `${studentCount(alias)} AS student_count, ${studentCount(alias, " AND s.gender = 'M'")} AS male_count, ${studentCount(alias, " AND s.gender = 'F'")} AS female_count`;

// ---------- 公開（不含學生個資，只有總數） ----------
export async function listPublicActivities(db, now = nowIso()) {
  const { results } = await db.prepare(
    `SELECT ${ACTIVITY_COLUMNS}, (SELECT COUNT(*) FROM registrations r WHERE r.activity_id = a.id AND r.${ACTIVE}) AS registered_count, ${STUDENT_COUNTS('a')}
     FROM activities a WHERE status IN ('open','closed','drawn') AND ends_at > ?1 ORDER BY starts_at ASC LIMIT 50`
  ).bind(now).all();
  return results || [];
}

// ---------- 教師報名 ----------
export function validateRegistration(body) {
  const activityId = String(body.activity_id || '');
  const classCode = String(body.class_code || '').trim();
  const teacherName = String(body.teacher_name || '').trim();
  const accompany = String(body.accompany || '');
  const notes = String(body.notes || '').trim();
  if (!activityId) throw new HttpError(400, '缺少活動');
  if (!CLASS_CODE.test(classCode)) throw new HttpError(400, '班級格式錯誤，請輸入如 701、815 的三位數班級');
  if (!teacherName || teacherName.length > 30) throw new HttpError(400, '請填寫導師姓名（30 字以內）');
  if (!ACCOMPANY.includes(accompany)) throw new HttpError(400, '請選擇是否隨班');
  if (notes.length > 200) throw new HttpError(400, '備註請在 200 字以內');
  return { activityId, classCode, teacherName, accompany, notes, students: validateStudents(body.students) };
}

// 學生名單：[{seat_no, name, gender: 'M'|'F'|'男'|'女'}]；座號不可重複。
export function validateStudents(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > 60) throw new HttpError(400, '學生名單格式錯誤（最多 60 人）');
  const seen = new Set();
  return list.map((s, i) => {
    const seat = Number(s && s.seat_no);
    const name = String((s && s.name) || '').trim();
    const gender = GENDER[String((s && s.gender) || '').trim()];
    const row = `第 ${i + 1} 位學生`;
    if (!Number.isInteger(seat) || seat < 1 || seat > 60) throw new HttpError(400, `${row}的座號須為 1–60`);
    if (seen.has(seat)) throw new HttpError(400, `座號 ${seat} 重複`);
    seen.add(seat);
    if (!name || name.length > 20) throw new HttpError(400, `${row}（座號 ${seat}）請填寫姓名（20 字以內）`);
    if (!gender) throw new HttpError(400, `${row}（座號 ${seat}）性別請填「男」或「女」`);
    return { seat_no: seat, name, gender };
  });
}

// 單一 INSERT…SELECT 敘述在 D1（SQLite）內為原子操作，且 D1 對同一資料庫的寫入是序列化的：
// 是否落在前 N 班（priority）由寫入當下的有效報名數決定，不會因同時送出而超額。
// 意願調查（survey）沒有名額：狀態一律為 pending（畫面顯示「已登記」），學生名單在同一交易寫入。
export async function register(db, user, input, now = nowIso()) {
  input = { ...input, students: input.students || [] };
  const activity = await db.prepare('SELECT kind, max_students_per_class FROM activities WHERE id = ?1').bind(input.activityId).first();
  if (activity && activity.kind === 'survey') {
    if (!input.students.length) throw new HttpError(400, '請填寫參加學生名單');
    if (activity.max_students_per_class && input.students.length > activity.max_students_per_class) {
      throw new HttpError(400, `每班最多 ${activity.max_students_per_class} 人`);
    }
  } else if (input.students.length) {
    throw new HttpError(400, '此活動不需填寫學生名單');
  }
  const id = crypto.randomUUID();
  let results;
  try {
    results = await db.batch([
      db.prepare(
        `INSERT INTO registrations (id, activity_id, class_code, teacher_name, teacher_email, accompany, notes, status, submitted_at)
         SELECT ?1, a.id, ?2, ?3, ?4, ?5, ?6,
                CASE WHEN a.kind = 'survey' THEN 'pending'
                     WHEN (SELECT COUNT(*) FROM registrations r WHERE r.activity_id = a.id AND r.${ACTIVE}) < a.priority_quota
                     THEN 'priority' ELSE 'lottery_pool' END,
                ?7
         FROM activities a
         WHERE a.id = ?8 AND a.status = 'open' AND a.opens_at <= ?7 AND a.deadline_at > ?7`
      ).bind(id, input.classCode, input.teacherName, user.email, input.accompany, input.notes, now, input.activityId),
      db.prepare(
        `INSERT INTO registration_students (registration_id, seat_no, name, gender)
         SELECT ?1, json_extract(j.value, '$.seat_no'), json_extract(j.value, '$.name'), json_extract(j.value, '$.gender')
         FROM json_each(?2) j WHERE EXISTS (SELECT 1 FROM registrations WHERE id = ?1)`
      ).bind(id, JSON.stringify(input.students)),
      db.prepare(
        `INSERT INTO audit_logs (actor_email, action, activity_id, details_json)
         SELECT ?1, 'register', activity_id, json_object('registration_id', id, 'class_code', class_code, 'status', status, 'student_count', ?3)
         FROM registrations WHERE id = ?2`
      ).bind(user.email, id, input.students.length)
    ]);
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) throw new HttpError(409, `${input.classCode} 班已經報名過此活動`);
    throw e;
  }
  if (!results[0].meta.changes) {
    const a = await db.prepare('SELECT status, opens_at, deadline_at FROM activities WHERE id = ?1').bind(input.activityId).first();
    if (!a || a.status === 'draft' || a.status === 'archived') throw new HttpError(404, '找不到此活動');
    if (now < a.opens_at) throw new HttpError(409, '尚未開放報名');
    throw new HttpError(409, '報名已截止');
  }
  return db.prepare('SELECT id, activity_id, class_code, status, submitted_at FROM registrations WHERE id = ?1').bind(id).first();
}

const STUDENT_COLUMNS = 's.id, s.registration_id, s.seat_no, s.name, s.gender, s.status, s.withdrawn_at, s.withdrawn_by, s.paid, s.paid_at, s.paid_by';

export async function listMyRegistrations(db, email) {
  const { results } = await db.prepare(
    `SELECT r.id, r.activity_id, r.class_code, r.teacher_name, r.accompany, r.notes, r.status, r.submitted_at, r.draw_rank,
            a.title, a.starts_at, a.ends_at, a.venue, a.deadline_at, a.lottery_at, a.kind
     FROM registrations r JOIN activities a ON a.id = r.activity_id
     WHERE r.teacher_email = ?1 ORDER BY r.submitted_at DESC`
  ).bind(email).all();
  const { results: students } = await db.prepare(
    `SELECT ${STUDENT_COLUMNS} FROM registration_students s JOIN registrations r ON r.id = s.registration_id
     WHERE r.teacher_email = ?1 ORDER BY s.seat_no`
  ).bind(email).all();
  return attachStudents(results || [], students || []);
}

function attachStudents(regs, students) {
  const by = new Map(regs.map(r => [r.id, Object.assign(r, { students: [] })]));
  for (const s of students) by.get(s.registration_id)?.students.push(s);
  return regs;
}

// 標記學生「不參加」：送出報名的導師在報名截止前可操作；管理員隨時可操作。不能新增學生。
export async function withdrawStudent(db, actor, registrationId, studentId, now = nowIso()) {
  const [res] = await db.batch([
    db.prepare(
      `UPDATE registration_students SET status = 'withdrawn', withdrawn_at = ?3, withdrawn_by = ?4
       WHERE id = ?2 AND registration_id = ?1 AND status = 'active' AND EXISTS (
         SELECT 1 FROM registrations r JOIN activities a ON a.id = r.activity_id
         WHERE r.id = ?1 AND r.status != 'cancelled' AND a.kind = 'survey' AND a.status != 'archived'
           AND (?5 = 1 OR (r.teacher_email = ?4 AND a.deadline_at > ?3)))`
    ).bind(registrationId, Number(studentId), now, actor.email, actor.isAdmin ? 1 : 0),
    studentAudit(db, actor.email, 'student_withdraw', registrationId, studentId)
  ]);
  if (!res.meta.changes) throw new HttpError(409, '無法變更：學生已標記不參加、報名已截止，或沒有權限');
}

export async function restoreStudent(db, admin, registrationId, studentId) {
  const [res] = await db.batch([
    db.prepare(
      `UPDATE registration_students SET status = 'active', withdrawn_at = NULL, withdrawn_by = NULL
       WHERE id = ?2 AND registration_id = ?1 AND status = 'withdrawn'`
    ).bind(registrationId, Number(studentId)),
    studentAudit(db, admin.email, 'student_restore', registrationId, studentId)
  ]);
  if (!res.meta.changes) throw new HttpError(409, '此學生目前不是「不參加」狀態');
}

export async function setStudentPaid(db, admin, registrationId, studentId, paid, now = nowIso()) {
  const [res] = await db.batch([
    db.prepare(
      `UPDATE registration_students SET paid = ?3, paid_at = CASE WHEN ?3 = 1 THEN ?4 END, paid_by = CASE WHEN ?3 = 1 THEN ?5 END
       WHERE id = ?2 AND registration_id = ?1 AND paid != ?3`
    ).bind(registrationId, Number(studentId), paid ? 1 : 0, now, admin.email),
    studentAudit(db, admin.email, paid ? 'student_paid' : 'student_unpaid', registrationId, studentId)
  ]);
  if (!res.meta.changes) throw new HttpError(409, '繳費狀態未變更');
}

function studentAudit(db, actor, action, registrationId, studentId) {
  return db.prepare(
    `INSERT INTO audit_logs (actor_email, action, activity_id, details_json)
     SELECT ?1, ?2, r.activity_id, json_object('registration_id', r.id, 'class_code', r.class_code, 'student_id', s.id, 'seat_no', s.seat_no, 'name', s.name)
     FROM registration_students s JOIN registrations r ON r.id = s.registration_id
     WHERE s.id = ?4 AND r.id = ?3 AND changes() = 1`
  ).bind(actor, action, registrationId, Number(studentId));
}

// ---------- 管理：活動 ----------
export function validateActivity(body) {
  const text = (k, max, required) => {
    const v = String(body[k] ?? '').trim();
    if (required && !v) throw new HttpError(400, `請填寫${LABELS[k]}`);
    if (v.length > max) throw new HttpError(400, `${LABELS[k]}請在 ${max} 字以內`);
    return v;
  };
  const time = (k) => {
    const v = taipeiToUtcIso(body[k + '_date'], body[k + '_time']);
    if (!v) throw new HttpError(400, `${LABELS[k]}的日期或時間格式錯誤`);
    return v;
  };
  const quota = (k) => {
    const n = Number(body[k]);
    if (!Number.isInteger(n) || n < 0 || n > 100) throw new HttpError(400, `${LABELS[k]}須為 0–100 的整數`);
    return n;
  };
  const kind = body.kind === undefined ? 'lecture' : String(body.kind);
  if (!['lecture', 'survey'].includes(kind)) throw new HttpError(400, '活動類型錯誤');
  const survey = kind === 'survey';
  let maxStudents = null;
  if (survey) {
    maxStudents = Number(body.max_students_per_class);
    if (!Number.isInteger(maxStudents) || maxStudents < 1 || maxStudents > 60) throw new HttpError(400, '每班人數上限須為 1–60 的整數');
  }
  const a = {
    title: text('title', 100, true), speaker: text('speaker', 100), venue: text('venue', 100),
    audience: text('audience', 100), description: text('description', 2000),
    starts_at: time('starts'), ends_at: time('ends'), opens_at: time('opens'), deadline_at: time('deadline'),
    // 意願調查沒有名額與抽籤
    priority_quota: survey ? 0 : quota('priority_quota'), lottery_quota: survey ? 0 : quota('lottery_quota'),
    kind, max_students_per_class: maxStudents
  };
  if (a.ends_at <= a.starts_at) throw new HttpError(400, '活動結束時間必須晚於開始時間');
  if (a.deadline_at <= a.opens_at) throw new HttpError(400, '報名截止時間必須晚於開放報名時間');
  if (a.deadline_at > a.starts_at) throw new HttpError(400, '報名截止時間不可晚於活動開始時間');
  return a;
}
const LABELS = {
  title: '活動名稱', speaker: '講師', venue: '地點', audience: '參加對象', description: '活動說明',
  starts: '活動開始', ends: '活動結束', opens: '開放報名', deadline: '報名截止',
  priority_quota: '優先錄取名額', lottery_quota: '抽籤名額'
};

export async function createActivity(db, admin, a) {
  const id = crypto.randomUUID();
  await db.batch([
    db.prepare(
      `INSERT INTO activities (id, title, speaker, venue, audience, description, starts_at, ends_at, opens_at, deadline_at, priority_quota, lottery_quota, status, created_by, kind, max_students_per_class)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'draft', ?13, ?14, ?15)`
    ).bind(id, a.title, a.speaker, a.venue, a.audience, a.description, a.starts_at, a.ends_at, a.opens_at, a.deadline_at, a.priority_quota, a.lottery_quota, admin.email, a.kind, a.max_students_per_class),
    audit(db, admin.email, 'activity_create', id, a)
  ]);
  return getActivity(db, id);
}

// 抽籤前隨時可修改（含開放後）；抽籤後時間與名額已用於公布結果，不可再改。
// 修改後依報名順序重新計算優先錄取（名額調整會影響哪些班級是 priority）。
export async function updateActivity(db, admin, id, a) {
  const before = await getActivity(db, id);
  if (!before) throw new HttpError(404, '找不到此活動');
  if (before.lottery_at || !EDITABLE.includes(before.status)) throw new HttpError(409, '已抽籤或已封存的活動不可修改');
  // 活動類型建立後不可變更（講座與意願調查的報名資料結構不同）
  if (a.kind !== before.kind) throw new HttpError(409, '活動類型建立後不可變更');
  const [res] = await db.batch([
    db.prepare(
      `UPDATE activities SET title=?2, speaker=?3, venue=?4, audience=?5, description=?6, starts_at=?7, ends_at=?8, opens_at=?9, deadline_at=?10, priority_quota=?11, lottery_quota=?12, max_students_per_class=?13
       WHERE id = ?1 AND status IN ('draft','open','closed') AND lottery_at IS NULL`
    ).bind(id, a.title, a.speaker, a.venue, a.audience, a.description, a.starts_at, a.ends_at, a.opens_at, a.deadline_at, a.priority_quota, a.lottery_quota, a.max_students_per_class),
    db.prepare(
      `INSERT INTO audit_logs (actor_email, action, activity_id, details_json) SELECT ?1, 'activity_update', ?2, ?3 WHERE changes() = 1`
    ).bind(admin.email, id, JSON.stringify({ before: pick(before), after: a })),
    ...recomputePriority(db, id, admin.email, 'activity_update')
  ]);
  if (!res.meta.changes) throw new HttpError(409, '已抽籤或已封存的活動不可修改');
  return getActivity(db, id);
}
const EDITABLE = ['draft', 'open', 'closed'];
const pick = r => Object.fromEntries(['title', 'speaker', 'venue', 'audience', 'description', 'starts_at', 'ends_at', 'opens_at', 'deadline_at', 'priority_quota', 'lottery_quota', 'kind', 'max_students_per_class'].map(k => [k, r[k]]));

// 抽籤前的單一規則：有效報名（priority + lottery_pool）依送出時間排序，前 N 班為 priority，其餘為 lottery_pool。
// 回傳兩個敘述，放進同一個 batch（交易）：先記錄將變動的班級，再更新狀態。
const RANKED = `SELECT r.id, r.class_code, r.status,
    CASE WHEN ROW_NUMBER() OVER (ORDER BY r.submitted_at, r.rowid) <= a.priority_quota THEN 'priority' ELSE 'lottery_pool' END AS new_status
  FROM registrations r JOIN activities a ON a.id = r.activity_id
  WHERE r.activity_id = ?1 AND a.lottery_at IS NULL AND r.status IN ('priority','lottery_pool')`;
function recomputePriority(db, activityId, actor, reason) {
  return [
    db.prepare(
      `INSERT INTO audit_logs (actor_email, action, activity_id, details_json)
       SELECT ?2, 'priority_recompute', ?1, json_object('reason', ?3, 'changes', json(ch)) FROM (
         SELECT json_group_array(json_object('class_code', class_code, 'from', status, 'to', new_status)) AS ch, COUNT(*) AS n
         FROM (${RANKED}) WHERE status != new_status
       ) WHERE n > 0`
    ).bind(activityId, actor, reason),
    db.prepare(
      `UPDATE registrations SET status = x.new_status FROM (${RANKED}) AS x
       WHERE registrations.id = x.id AND registrations.status != x.new_status`
    ).bind(activityId)
  ];
}

const TRANSITIONS = { draft: ['open', 'archived'], open: ['closed'], closed: ['open', 'archived'], drawn: ['archived'], archived: [] };

export async function setActivityStatus(db, admin, id, next) {
  const current = await getActivity(db, id);
  if (!current) throw new HttpError(404, '找不到此活動');
  if (!(TRANSITIONS[current.status] || []).includes(next)) throw new HttpError(409, `無法從「${current.status}」改為「${next}」`);
  const [res] = await db.batch([
    db.prepare('UPDATE activities SET status = ?3 WHERE id = ?1 AND status = ?2').bind(id, current.status, next),
    db.prepare(
      `INSERT INTO audit_logs (actor_email, action, activity_id, details_json)
       SELECT ?1, 'activity_status', ?2, ?3 WHERE changes() = 1`
    ).bind(admin.email, id, JSON.stringify({ from: current.status, to: next }))
  ]);
  if (!res.meta.changes) throw new HttpError(409, '活動狀態已被變更，請重新整理');
  return getActivity(db, id);
}

export function getActivity(db, id) {
  return db.prepare(`SELECT ${ACTIVITY_COLUMNS}, created_by, created_at FROM activities WHERE id = ?1`).bind(id).first();
}

export async function listAdminActivities(db) {
  const { results } = await db.prepare(
    `SELECT ${ACTIVITY_COLUMNS}, created_by, created_at,
       (SELECT COUNT(*) FROM registrations r WHERE r.activity_id = a.id AND r.status = 'priority') AS priority_count,
       (SELECT COUNT(*) FROM registrations r WHERE r.activity_id = a.id AND r.status = 'lottery_pool') AS pool_count,
       (SELECT COUNT(*) FROM registrations r WHERE r.activity_id = a.id AND r.status = 'selected') AS selected_count,
       (SELECT COUNT(*) FROM registrations r WHERE r.activity_id = a.id AND r.status = 'not_selected') AS not_selected_count,
       (SELECT COUNT(*) FROM registrations r WHERE r.activity_id = a.id AND r.status = 'cancelled') AS cancelled_count,
       (SELECT COUNT(*) FROM registrations r WHERE r.activity_id = a.id AND r.status = 'pending') AS registered_count,
       ${STUDENT_COUNTS('a')}
     FROM activities a ORDER BY starts_at DESC`
  ).all();
  return results || [];
}

export async function listRegistrations(db, activityId) {
  const { results } = await db.prepare(
    `SELECT id, class_code, teacher_name, teacher_email, accompany, notes, status, submitted_at, draw_rank
     FROM registrations WHERE activity_id = ?1 ORDER BY submitted_at ASC, rowid ASC`
  ).bind(activityId).all();
  const { results: students } = await db.prepare(
    `SELECT ${STUDENT_COLUMNS} FROM registration_students s JOIN registrations r ON r.id = s.registration_id
     WHERE r.activity_id = ?1 ORDER BY s.seat_no`
  ).bind(activityId).all();
  return attachStudents(results || [], students || []);
}

// 抽籤前取消：抽籤候選中最早報名者自動遞補為優先錄取；被取消的班級可重新報名（排在最後）。
// 抽籤後取消：不重新計算，名額異動由管理員人工處理。
export async function cancelRegistration(db, admin, activityId, registrationId, reason) {
  const [res] = await db.batch([
    db.prepare(`UPDATE registrations SET status = 'cancelled' WHERE id = ?1 AND activity_id = ?2 AND status != 'cancelled'`).bind(registrationId, activityId),
    db.prepare(
      `INSERT INTO audit_logs (actor_email, action, activity_id, details_json)
       SELECT ?1, 'registration_cancel', activity_id, json_object('registration_id', id, 'class_code', class_code, 'reason', ?3)
       FROM registrations WHERE id = ?2 AND activity_id = ?4 AND status = 'cancelled' AND changes() = 1`
    ).bind(admin.email, registrationId, String(reason || '').slice(0, 200), activityId),
    ...recomputePriority(db, activityId, admin.email, 'registration_cancel')
  ]);
  if (!res.meta.changes) throw new HttpError(404, '找不到此報名或已取消');
}

// ---------- 抽籤 ----------
// 可稽核的抽籤：產生 32 bytes 隨機種子，每位候選者的排序鍵 = HMAC-SHA256(種子, 報名 id)，依鍵值由小到大取前 N 名。
// 種子、候選名單與結果都寫入 audit_logs，任何人可用相同種子重算驗證結果。
export async function drawLottery(db, admin, activityId, now = nowIso(), seedBytes = crypto.getRandomValues(new Uint8Array(32))) {
  const activity = await getActivity(db, activityId);
  if (!activity) throw new HttpError(404, '找不到此活動');
  if (activity.kind === 'survey') throw new HttpError(409, '意願調查不需要抽籤');
  if (activity.lottery_at) throw new HttpError(409, '此活動已經抽過籤，不可重複抽籤');
  if (!['open', 'closed'].includes(activity.status)) throw new HttpError(409, '活動狀態不允許抽籤');
  if (now < activity.deadline_at) throw new HttpError(409, '報名尚未截止，不能抽籤');

  const { results: pool } = await db.prepare(
    `SELECT id, class_code FROM registrations WHERE activity_id = ?1 AND status = 'lottery_pool' ORDER BY id`
  ).bind(activityId).all();
  const seedHex = toHex(seedBytes);
  const ranked = await rankPool(seedBytes, pool || []);
  const winners = new Set(ranked.slice(0, activity.lottery_quota).map(r => r.id));

  // 以 lottery_at = 本次時間戳作為鎖：只有第一個成功設定的請求，其後續 UPDATE 條件才會成立。
  const guard = `(SELECT lottery_at FROM activities WHERE id = ?2) = ?3`;
  const stmts = [
    db.prepare(`UPDATE activities SET lottery_at = ?2, status = 'drawn' WHERE id = ?1 AND lottery_at IS NULL AND status IN ('open','closed') AND deadline_at <= ?2`)
      .bind(activityId, now),
    ...ranked.map((r, i) => db.prepare(
      `UPDATE registrations SET status = ?4, draw_rank = ?5 WHERE id = ?1 AND status = 'lottery_pool' AND ${guard}`
    ).bind(r.id, activityId, now, winners.has(r.id) ? 'selected' : 'not_selected', i + 1)),
    db.prepare(
      `INSERT INTO audit_logs (actor_email, action, activity_id, details_json) SELECT ?1, 'lottery_draw', ?2, ?4 WHERE ${guard}`
    ).bind(admin.email, activityId, now, JSON.stringify({
      algorithm: 'HMAC-SHA256(seed, registration_id) ascending', seed: seedHex, quota: activity.lottery_quota,
      pool: ranked.map(r => ({ id: r.id, class_code: r.class_code, key: r.key })),
      selected: ranked.filter(r => winners.has(r.id)).map(r => r.class_code)
    }))
  ];
  const results = await db.batch(stmts);
  if (!results[0].meta.changes) throw new HttpError(409, '此活動已經抽過籤，不可重複抽籤');
  return { seed: seedHex, drawn_at: now, pool_size: ranked.length, selected: ranked.filter(r => winners.has(r.id)).map(r => r.class_code) };
}

export async function rankPool(seedBytes, pool) {
  const key = await crypto.subtle.importKey('raw', seedBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const enc = new TextEncoder();
  const keyed = await Promise.all(pool.map(async r => ({ ...r, key: toHex(await crypto.subtle.sign('HMAC', key, enc.encode(r.id))) })));
  return keyed.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function audit(db, actor, action, activityId, details) {
  return db.prepare('INSERT INTO audit_logs (actor_email, action, activity_id, details_json) VALUES (?1, ?2, ?3, ?4)')
    .bind(actor, action, activityId, JSON.stringify(details));
}

const CSV_STATUS = { priority: '優先錄取', lottery_pool: '抽籤候選', selected: '抽籤錄取', not_selected: '未錄取', cancelled: '已取消', pending: '已登記' };
const csvCell = v => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // 防止試算表公式注入
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const taipei = iso => (iso ? new Date(Date.parse(iso) + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ') : '');
const csvDoc = (head, lines) => '﻿' + [head.join(','), ...lines.map(l => l.map(csvCell).join(','))].join('\r\n') + '\r\n';

export function toCsv(rows) {
  const head = ['順序', '班級', '導師', 'Email', '隨班', '狀態', '抽籤排名', '報名時間（臺灣）', '備註'];
  return csvDoc(head, rows.map((r, i) => [i + 1, r.class_code, r.teacher_name, r.teacher_email, r.accompany === 'yes' ? '是' : '否',
    CSV_STATUS[r.status] || r.status, r.draw_rank ?? '', taipei(r.submitted_at), r.notes]));
}

// 意願調查：一位學生一列，供收費對帳。
export function toStudentsCsv(rows) {
  const head = ['班級', '座號', '姓名', '性別', '參加', '繳費', '繳費登記時間（臺灣）', '班級報名狀態', '導師', 'Email', '隨班', '報名時間（臺灣）', '備註'];
  const lines = [];
  for (const r of [...rows].sort((x, y) => x.class_code.localeCompare(y.class_code))) {
    for (const s of r.students) {
      lines.push([r.class_code, s.seat_no, s.name, s.gender === 'M' ? '男' : '女', s.status === 'active' ? '參加' : '不參加',
        s.paid ? '已繳' : '未繳', taipei(s.paid_at), CSV_STATUS[r.status] || r.status, r.teacher_name, r.teacher_email,
        r.accompany === 'yes' ? '是' : '否', taipei(r.submitted_at), r.notes]);
    }
  }
  return csvDoc(head, lines);
}
