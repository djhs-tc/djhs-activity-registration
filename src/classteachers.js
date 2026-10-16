import { HttpError } from './http.js';
import { CLASS_CODE } from './activities.js';
import { normalizeEmail } from './allowlist.js';

// 班級導師名單：班級 → 導師姓名、信箱。只有管理員能維護，每次異動寫入稽核紀錄。
// 用途：導師在「我的報名」查看本班學生的報名、錄取與繳費（不限制報名）。
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
export const CLASS_BATCH_MAX = 120;

export async function listClassTeachers(db) {
  const { results } = await db.prepare('SELECT class_code, teacher_name, teacher_email, updated_by, updated_at FROM class_teachers ORDER BY class_code').all();
  return results || [];
}

export async function classTeacher(db, classCode) {
  return db.prepare('SELECT teacher_name, teacher_email FROM class_teachers WHERE class_code = ?1').bind(classCode).first();
}

export async function myClasses(db, email) {
  const { results } = await db.prepare('SELECT class_code FROM class_teachers WHERE teacher_email = ?1 ORDER BY class_code').bind(normalizeEmail(email)).all();
  return (results || []).map(r => r.class_code);
}

// 批次設定：整批檢查，任何一筆有誤就整批不寫入；同班級已有資料時更新為新導師。
export async function setClassTeachersBatch(db, admin, entries) {
  if (!Array.isArray(entries) || !entries.length) throw new HttpError(400, '請至少輸入一筆');
  if (entries.length > CLASS_BATCH_MAX) throw new HttpError(400, `一次最多 ${CLASS_BATCH_MAX} 筆`);
  const errors = [];
  const rows = new Map();
  entries.forEach((e, i) => {
    const class_code = String((e && e.class_code) || '').trim();
    const teacher_name = String((e && e.teacher_name) || '').trim();
    const teacher_email = normalizeEmail(e && e.teacher_email);
    let err = null;
    if (!CLASS_CODE.test(class_code)) err = '班級格式錯誤（如 701）';
    else if (!teacher_name || teacher_name.length > 30) err = '請填寫導師姓名（30 字以內）';
    else if (!EMAIL.test(teacher_email) || teacher_email.length > 100) err = '信箱格式錯誤';
    else if (rows.has(class_code)) err = `班級 ${class_code} 重複`;
    if (err) errors.push(`第 ${i + 1} 筆（${class_code || '空白'}）：${err}`);
    else rows.set(class_code, { class_code, teacher_name, teacher_email });
  });
  if (errors.length) throw new HttpError(400, '資料有誤，整批未寫入：\n' + errors.slice(0, 20).join('\n') + (errors.length > 20 ? `\n…另有 ${errors.length - 20} 筆錯誤` : ''));
  const list = JSON.stringify([...rows.values()]);
  await db.batch([
    db.prepare(
      `INSERT INTO audit_logs (actor_email, action, details_json)
       SELECT ?2, 'class_teacher_set', json_object('class_code', j.class_code, 'teacher_name', j.teacher_name, 'teacher_email', j.teacher_email,
                                                   'previous_email', (SELECT teacher_email FROM class_teachers c WHERE c.class_code = j.class_code))
       FROM (SELECT json_extract(value, '$.class_code') AS class_code, json_extract(value, '$.teacher_name') AS teacher_name,
                    json_extract(value, '$.teacher_email') AS teacher_email FROM json_each(?1)) j`
    ).bind(list, admin.email),
    db.prepare(
      `INSERT INTO class_teachers (class_code, teacher_name, teacher_email, updated_by, updated_at)
       SELECT json_extract(value, '$.class_code'), json_extract(value, '$.teacher_name'), json_extract(value, '$.teacher_email'), ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now')
       FROM json_each(?1) WHERE true
       ON CONFLICT(class_code) DO UPDATE SET teacher_name = excluded.teacher_name, teacher_email = excluded.teacher_email,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`
    ).bind(list, admin.email)
  ]);
  return { saved: rows.size };
}

export async function removeClassTeacher(db, admin, classCode) {
  const code = String(classCode || '').trim();
  const [, res] = await db.batch([
    db.prepare(
      `INSERT INTO audit_logs (actor_email, action, details_json)
       SELECT ?1, 'class_teacher_remove', json_object('class_code', class_code, 'teacher_email', teacher_email) FROM class_teachers WHERE class_code = ?2`
    ).bind(admin.email, code),
    db.prepare('DELETE FROM class_teachers WHERE class_code = ?1').bind(code)
  ]);
  if (!res.meta.changes) throw new HttpError(404, '名單中沒有此班級');
}
