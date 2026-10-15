import { HttpError, taipeiToUtcIso, nowIso } from './http.js';

const ACTIVITY_COLUMNS = 'id, title, speaker, venue, audience, description, starts_at, ends_at, opens_at, deadline_at, priority_quota, lottery_quota, status, lottery_at';
const ACTIVE = "status != 'cancelled'";
// 班級代碼：年級 7–9 + 班號 01–30，例如 701、815。
export const CLASS_CODE = /^[789](0[1-9]|[12]\d|30)$/;
const ACCOMPANY = ['yes', 'no'];

// ---------- 公開 ----------
export async function listPublicActivities(db, now = nowIso()) {
  const { results } = await db.prepare(
    `SELECT ${ACTIVITY_COLUMNS}, (SELECT COUNT(*) FROM registrations r WHERE r.activity_id = a.id AND r.${ACTIVE}) AS registered_count
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
  return { activityId, classCode, teacherName, accompany, notes };
}

// 單一 INSERT…SELECT 敘述在 D1（SQLite）內為原子操作，且 D1 對同一資料庫的寫入是序列化的：
// 是否落在前 N 班（priority）由寫入當下的有效報名數決定，不會因同時送出而超額。
export async function register(db, user, input, now = nowIso()) {
  const id = crypto.randomUUID();
  let results;
  try {
    results = await db.batch([
      db.prepare(
        `INSERT INTO registrations (id, activity_id, class_code, teacher_name, teacher_email, accompany, notes, status, submitted_at)
         SELECT ?1, a.id, ?2, ?3, ?4, ?5, ?6,
                CASE WHEN (SELECT COUNT(*) FROM registrations r WHERE r.activity_id = a.id AND r.${ACTIVE}) < a.priority_quota
                     THEN 'priority' ELSE 'lottery_pool' END,
                ?7
         FROM activities a
         WHERE a.id = ?8 AND a.status = 'open' AND a.opens_at <= ?7 AND a.deadline_at > ?7`
      ).bind(id, input.classCode, input.teacherName, user.email, input.accompany, input.notes, now, input.activityId),
      db.prepare(
        `INSERT INTO audit_logs (actor_email, action, activity_id, details_json)
         SELECT ?1, 'register', activity_id, json_object('registration_id', id, 'class_code', class_code, 'status', status)
         FROM registrations WHERE id = ?2`
      ).bind(user.email, id)
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

export async function listMyRegistrations(db, email) {
  const { results } = await db.prepare(
    `SELECT r.id, r.activity_id, r.class_code, r.teacher_name, r.accompany, r.notes, r.status, r.submitted_at, r.draw_rank,
            a.title, a.starts_at, a.ends_at, a.venue, a.deadline_at, a.lottery_at
     FROM registrations r JOIN activities a ON a.id = r.activity_id
     WHERE r.teacher_email = ?1 ORDER BY r.submitted_at DESC`
  ).bind(email).all();
  return results || [];
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
  const a = {
    title: text('title', 100, true), speaker: text('speaker', 100), venue: text('venue', 100),
    audience: text('audience', 100), description: text('description', 2000),
    starts_at: time('starts'), ends_at: time('ends'), opens_at: time('opens'), deadline_at: time('deadline'),
    priority_quota: quota('priority_quota'), lottery_quota: quota('lottery_quota')
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
      `INSERT INTO activities (id, title, speaker, venue, audience, description, starts_at, ends_at, opens_at, deadline_at, priority_quota, lottery_quota, status, created_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'draft', ?13)`
    ).bind(id, a.title, a.speaker, a.venue, a.audience, a.description, a.starts_at, a.ends_at, a.opens_at, a.deadline_at, a.priority_quota, a.lottery_quota, admin.email),
    audit(db, admin.email, 'activity_create', id, a)
  ]);
  return getActivity(db, id);
}

// 只有草稿可以修改，避免開放後改動名額或期限造成爭議。
export async function updateActivity(db, admin, id, a) {
  const [res] = await db.batch([
    db.prepare(
      `UPDATE activities SET title=?2, speaker=?3, venue=?4, audience=?5, description=?6, starts_at=?7, ends_at=?8, opens_at=?9, deadline_at=?10, priority_quota=?11, lottery_quota=?12
       WHERE id = ?1 AND status = 'draft'`
    ).bind(id, a.title, a.speaker, a.venue, a.audience, a.description, a.starts_at, a.ends_at, a.opens_at, a.deadline_at, a.priority_quota, a.lottery_quota),
    db.prepare(
      `INSERT INTO audit_logs (actor_email, action, activity_id, details_json)
       SELECT ?1, 'activity_update', id, ?3 FROM activities WHERE id = ?2 AND status = 'draft'`
    ).bind(admin.email, id, JSON.stringify(a))
  ]);
  if (!res.meta.changes) throw new HttpError(409, '只有草稿狀態的活動可以修改');
  return getActivity(db, id);
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
       (SELECT COUNT(*) FROM registrations r WHERE r.activity_id = a.id AND r.status = 'cancelled') AS cancelled_count
     FROM activities a ORDER BY starts_at DESC`
  ).all();
  return results || [];
}

export async function listRegistrations(db, activityId) {
  const { results } = await db.prepare(
    `SELECT id, class_code, teacher_name, teacher_email, accompany, notes, status, submitted_at, draw_rank
     FROM registrations WHERE activity_id = ?1 ORDER BY submitted_at ASC, rowid ASC`
  ).bind(activityId).all();
  return results || [];
}

// 取消不會自動遞補，名額異動由管理員人工處理（見 README）。
export async function cancelRegistration(db, admin, activityId, registrationId, reason) {
  const [res] = await db.batch([
    db.prepare(`UPDATE registrations SET status = 'cancelled' WHERE id = ?1 AND activity_id = ?2 AND status != 'cancelled'`).bind(registrationId, activityId),
    db.prepare(
      `INSERT INTO audit_logs (actor_email, action, activity_id, details_json)
       SELECT ?1, 'registration_cancel', activity_id, json_object('registration_id', id, 'class_code', class_code, 'reason', ?3)
       FROM registrations WHERE id = ?2 AND activity_id = ?4 AND status = 'cancelled' AND changes() = 1`
    ).bind(admin.email, registrationId, String(reason || '').slice(0, 200), activityId)
  ]);
  if (!res.meta.changes) throw new HttpError(404, '找不到此報名或已取消');
}

// ---------- 抽籤 ----------
// 可稽核的抽籤：產生 32 bytes 隨機種子，每位候選者的排序鍵 = HMAC-SHA256(種子, 報名 id)，依鍵值由小到大取前 N 名。
// 種子、候選名單與結果都寫入 audit_logs，任何人可用相同種子重算驗證結果。
export async function drawLottery(db, admin, activityId, now = nowIso(), seedBytes = crypto.getRandomValues(new Uint8Array(32))) {
  const activity = await getActivity(db, activityId);
  if (!activity) throw new HttpError(404, '找不到此活動');
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

export function toCsv(rows) {
  const STATUS = { priority: '優先錄取', lottery_pool: '抽籤候選', selected: '抽籤錄取', not_selected: '未錄取', cancelled: '已取消', pending: '處理中' };
  const head = ['順序', '班級', '導師', 'Email', '隨班', '狀態', '抽籤排名', '報名時間（臺灣）', '備註'];
  const cell = v => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // 防止試算表公式注入
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const taipei = iso => new Date(Date.parse(iso) + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
  const lines = rows.map((r, i) => [i + 1, r.class_code, r.teacher_name, r.teacher_email, r.accompany === 'yes' ? '是' : '否',
    STATUS[r.status] || r.status, r.draw_rank ?? '', taipei(r.submitted_at), r.notes].map(cell).join(','));
  return '﻿' + [head.join(','), ...lines].join('\r\n') + '\r\n';
}
