// 營隊意願調查：學生名單、男女統計、導師標記不參加、管理員恢復與繳費。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './d1-shim.mjs';
import { signSession } from '../src/auth.js';
import { validateStudents, toStudentsCsv, listRegistrations } from '../src/activities.js';
import worker from '../src/index.js';

const SECRET = 's'.repeat(40);
const ADMIN = 'tjjh111@tjjh.tc.edu.tw';
const ORIGIN = 'https://djhs.test';

function setup() {
  const DB = createD1();
  const env = { DB, ASSETS: { fetch: async () => new Response('asset') }, GOOGLE_CLIENT_ID: '123456789-abcdef.apps.googleusercontent.com', SESSION_SECRET: SECRET, ADMIN_EMAILS: ADMIN, ALLOWED_EMAIL_DOMAINS: 'st.tc.edu.tw,tjjh.tc.edu.tw' };
  async function call(path, { body, as, method } = {}) {
    const headers = {};
    if (as) headers.cookie = '__Host-djhs_session=' + await signSession({ email: as, name: 'n' }, SECRET);
    if (body !== undefined) { headers['content-type'] = 'application/json'; headers.origin = ORIGIN; }
    const res = await worker.fetch(new Request(ORIGIN + path, { method: method || (body !== undefined ? 'POST' : 'GET'), headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {} });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch (_) { data = text; }
    return { status: res.status, data };
  }
  return { DB, call };
}
const tp = m => { const d = new Date(Date.now() + 8 * 3600e3 + m * 60e3).toISOString(); return { date: d.slice(0, 10), time: d.slice(11, 16) }; };
function surveyBody(over = {}) {
  const s = tp(60 * 24 * 30), e = tp(60 * 24 * 32), o = tp(-60), d = tp(60 * 24);
  return { kind: 'survey', title: '暑期營隊', speaker: '', venue: '', audience: '七年級', description: '',
    starts_date: s.date, starts_time: s.time, ends_date: e.date, ends_time: e.time, opens_date: o.date, opens_time: o.time,
    deadline_date: d.date, deadline_time: d.time, max_students_per_class: 5, fee: 100, min_participants: 20, organizer_name: '教學組長', organizer_email: 'tjjh111@tjjh.tc.edu.tw', ...over };
}
const T1 = 't1@st.tc.edu.tw', T2 = 't2@st.tc.edu.tw';
const roster = [{ seat_no: 1, name: '王小明', gender: '男' }, { seat_no: 2, name: '李小華', gender: '女' }, { seat_no: 5, name: '陳大同', gender: 'M' }];
const reg = (id, code, students = roster) => ({ activity_id: id, class_code: code, teacher_name: '導師', accompany: 'no', notes: '', students });

async function openSurvey(call, over) {
  const c = await call('/api/admin/activities', { body: surveyBody(over), as: ADMIN });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  assert.equal(c.data.activity.kind, 'survey');
  assert.equal(c.data.activity.priority_quota, 0);
  await call(`/api/admin/activities/${c.data.activity.id}/status`, { body: { status: 'open' }, as: ADMIN });
  return c.data.activity.id;
}

test('student roster validation', () => {
  assert.deepEqual(validateStudents([{ seat_no: '3', name: ' 王 ', gender: '女' }]), [{ seat_no: 3, name: '王', gender: 'F' }]);
  assert.throws(() => validateStudents([{ seat_no: 1, name: 'a', gender: '男' }, { seat_no: 1, name: 'b', gender: '女' }]), /座號 1 重複/);
  assert.throws(() => validateStudents([{ seat_no: 0, name: 'a', gender: '男' }]), /座號/);
  assert.throws(() => validateStudents([{ seat_no: 1, name: '', gender: '男' }]), /姓名/);
  assert.throws(() => validateStudents([{ seat_no: 1, name: 'a', gender: 'x' }]), /性別/);
  assert.throws(() => validateStudents('nope'), /格式/);
});

test('survey: register with roster, gender counts, no lottery, public shows totals only', async () => {
  const { call } = setup();
  const id = await openSurvey(call);
  const r = await call('/api/registrations', { body: reg(id, '701'), as: T1 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.registration.status, 'pending');
  assert.equal((await call('/api/registrations', { body: reg(id, '702', []), as: T2 })).status, 400);
  assert.match((await call('/api/registrations', { body: reg(id, '702', Array.from({ length: 6 }, (_, i) => ({ seat_no: i + 1, name: 'x', gender: '男' }))), as: T2 })).data.error, /最多 5 人/);
  assert.equal((await call('/api/registrations', { body: reg(id, '702', [{ seat_no: 1, name: '張', gender: '女' }]), as: T2 })).status, 201);

  const pub = (await call('/api/activities')).data.activities[0];
  assert.deepEqual([pub.registered_count, pub.student_count, pub.male_count, pub.female_count], [2, 4, 2, 2]);
  assert.ok(!JSON.stringify(pub).includes('王小明'), 'public listing must not contain student names');

  const adm = (await call('/api/admin/activities', { as: ADMIN })).data.activities[0];
  assert.deepEqual([adm.student_count, adm.male_count, adm.female_count], [4, 2, 2]);
  assert.match((await call(`/api/admin/activities/${id}/draw`, { body: {}, as: ADMIN })).data.error, /不需要抽籤/);
});

test('lecture activities reject a student roster', async () => {
  const { call } = setup();
  const s = tp(60 * 24 * 7), e = tp(60 * 24 * 7 + 120), o = tp(-60), d = tp(60);
  const c = await call('/api/admin/activities', { body: { title: '講座', starts_date: s.date, starts_time: s.time, ends_date: e.date, ends_time: e.time, opens_date: o.date, opens_time: o.time, deadline_date: d.date, deadline_time: d.time, priority_quota: 15, lottery_quota: 3, organizer_name: '教學組長', organizer_email: 'tjjh111@tjjh.tc.edu.tw',  }, as: ADMIN });
  assert.equal(c.data.activity.kind, 'lecture');
  await call(`/api/admin/activities/${c.data.activity.id}/status`, { body: { status: 'open' }, as: ADMIN });
  assert.match((await call('/api/registrations', { body: reg(c.data.activity.id, '701'), as: T1 })).data.error, /不需填寫學生名單/);
});

test('teacher can only withdraw own students, cannot add; admin can restore; counts follow', async () => {
  const { call, DB } = setup();
  const id = await openSurvey(call);
  await call('/api/registrations', { body: reg(id, '701'), as: T1 });
  const mine = (await call('/api/my/registrations', { as: T1 })).data.registrations[0];
  assert.equal(mine.kind, 'survey');
  assert.deepEqual(mine.students.map(s => [s.seat_no, s.name, s.gender, s.status]), [[1, '王小明', 'M', 'active'], [2, '李小華', 'F', 'active'], [5, '陳大同', 'M', 'active']]);
  const sid = mine.students[0].id;
  const path = `/api/registrations/${mine.id}/students/${sid}/withdraw`;

  assert.equal((await call(path, { body: {}, as: T2 })).status, 409, 'another teacher cannot withdraw');
  assert.equal((await call('/api/my/registrations', { as: T2 })).data.registrations.length, 0, 'another teacher cannot see roster');
  assert.equal((await call(path, { body: {} })).status, 401);
  assert.equal((await call(path, { body: {}, as: T1 })).status, 200);
  assert.equal((await call(path, { body: {}, as: T1 })).status, 409, 'already withdrawn');

  let adm = (await call('/api/admin/activities', { as: ADMIN })).data.activities[0];
  assert.deepEqual([adm.student_count, adm.male_count, adm.female_count], [2, 1, 1]);

  const restore = `/api/admin/registrations/${mine.id}/students/${sid}/restore`;
  assert.equal((await call(restore, { body: {}, as: T1 })).status, 403, 'teacher cannot restore');
  assert.equal((await call(restore, { body: {}, as: ADMIN })).status, 200);
  adm = (await call('/api/admin/activities', { as: ADMIN })).data.activities[0];
  assert.equal(adm.student_count, 3);

  const actions = DB.raw.prepare(`SELECT action FROM audit_logs WHERE action LIKE 'student_%' ORDER BY id`).all().map(r => r.action);
  assert.deepEqual(actions, ['student_withdraw', 'student_restore']);
});

test('teacher cannot withdraw after the deadline; admin still can', async () => {
  const { call, DB } = setup();
  const id = await openSurvey(call);
  await call('/api/registrations', { body: reg(id, '701'), as: T1 });
  const mine = (await call('/api/my/registrations', { as: T1 })).data.registrations[0];
  DB.raw.prepare(`UPDATE activities SET deadline_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(id);
  const path = `/api/registrations/${mine.id}/students/${mine.students[1].id}/withdraw`;
  assert.equal((await call(path, { body: {}, as: T1 })).status, 409);
  assert.equal((await call(path, { body: {}, as: ADMIN })).status, 200);
});

test('admin marks paid; students CSV one row per student; cancelled class excluded from counts', async () => {
  const { call, DB } = setup();
  const id = await openSurvey(call);
  await call('/api/registrations', { body: reg(id, '702', [{ seat_no: 3, name: '=cmd', gender: '女' }]), as: T2 });
  await call('/api/registrations', { body: reg(id, '701'), as: T1 });
  const list = (await call(`/api/admin/activities/${id}/registrations`, { as: ADMIN })).data.registrations;
  const r701 = list.find(r => r.class_code === '701');
  const paid = `/api/admin/registrations/${r701.id}/students/${r701.students[0].id}/paid`;
  assert.equal((await call(paid, { body: { paid: true }, as: T1 })).status, 403);
  assert.equal((await call(paid, { body: { paid: 'yes' }, as: ADMIN })).status, 400);
  assert.equal((await call(paid, { body: { paid: true }, as: ADMIN })).status, 200);
  assert.equal((await call(paid, { body: { paid: true }, as: ADMIN })).status, 409);

  const csv = (await call(`/api/admin/activities/${id}/registrations.csv`, { as: ADMIN })).data;
  const lines = csv.trim().split('\r\n');
  assert.match(lines[0].replace(/^﻿/, ''), /^班級,座號,姓名,性別,參加,繳費/);
  assert.equal(lines.length, 1 + 4);
  assert.match(lines[1], /^701,1,王小明,男,參加,已繳,/);
  assert.match(lines[4], /^702,3,'=cmd,女,參加,未繳/);

  const r702 = list.find(r => r.class_code === '702');
  await call(`/api/admin/activities/${id}/registrations/${r702.id}/cancel`, { body: { reason: 'x' }, as: ADMIN });
  const adm = (await call('/api/admin/activities', { as: ADMIN })).data.activities[0];
  assert.deepEqual([adm.student_count, adm.female_count], [3, 1]);
  // 取消的班級可以重新報名（新名單）
  assert.equal((await call('/api/registrations', { body: reg(id, '702', [{ seat_no: 4, name: '林', gender: '男' }]), as: T2 })).status, 201);
  const rows = await listRegistrations(DB, id);
  assert.equal(rows.filter(r => r.class_code === '702').length, 2);
  assert.ok(toStudentsCsv(rows).includes('已取消'));
});

test('activity kind cannot change after creation; survey max is editable', async () => {
  const { call } = setup();
  const id = await openSurvey(call);
  const current = async id => (await call('/api/admin/activities', { as: ADMIN })).data.activities.find(a => a.id === id);
  assert.match((await call(`/api/admin/activities/${id}`, { method: 'PUT', body: { ...surveyBody(), kind: 'lecture', priority_quota: 15, lottery_quota: 3, base: await current(id) }, as: ADMIN })).data.error, /類型/);
  const ok = await call(`/api/admin/activities/${id}`, { method: 'PUT', body: { ...surveyBody({ max_students_per_class: 40 }), base: await current(id) }, as: ADMIN });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.activity.max_students_per_class, 40);
  assert.match((await call('/api/admin/activities', { body: surveyBody({ max_students_per_class: 0 }), as: ADMIN })).data.error, /人數上限/);
});

test('fee and minimum participants: validated, public, free camps show 免費 in CSV', async () => {
  const { call } = setup();
  assert.match((await call('/api/admin/activities', { body: surveyBody({ fee: -1 }), as: ADMIN })).data.error, /費用/);
  assert.match((await call('/api/admin/activities', { body: surveyBody({ min_participants: 1.5 }), as: ADMIN })).data.error, /最低開班人數/);
  const id = await openSurvey(call, { title: '數學精進營', fee: 0, min_participants: 6 });
  const pub = (await call('/api/activities')).data.activities.find(a => a.id === id);
  assert.deepEqual([pub.fee, pub.min_participants], [0, 6]);
  await call('/api/registrations', { body: reg(id, '701'), as: T1 });
  const csv = (await call(`/api/admin/activities/${id}/registrations.csv`, { as: ADMIN })).data;
  assert.match(csv, /701,1,王小明,男,參加,免費,,/);
  // 講座的費用與門檻一律為 0
  const s = tp(60 * 24 * 7), e = tp(60 * 24 * 7 + 120), o = tp(-60), d = tp(60);
  const lec = await call('/api/admin/activities', { body: { title: '講座', starts_date: s.date, starts_time: s.time, ends_date: e.date, ends_time: e.time, opens_date: o.date, opens_time: o.time, deadline_date: d.date, deadline_time: d.time, priority_quota: 15, lottery_quota: 3, fee: 500, min_participants: 9, organizer_name: '組長', organizer_email: 'a@st.tc.edu.tw' }, as: ADMIN });
  assert.deepEqual([lec.data.activity.fee, lec.data.activity.min_participants], [0, 0]);
});

// ---------- 人數上限：額滿即截止／超過名額改抽籤 ----------
const roster3 = start => [0, 1, 2].map(i => ({ seat_no: start + i, name: 'S' + (start + i), gender: i % 2 ? '女' : '男' }));

test('capacity close mode: rejects rosters that would exceed the cap, counts free up on withdraw', async () => {
  const { call } = setup();
  assert.match((await call('/api/admin/activities', { body: surveyBody({ max_participants: 5, min_participants: 6 }), as: ADMIN })).data.error, /不可大於人數上限/);
  const id = await openSurvey(call, { max_participants: 5, overflow_mode: 'close', min_participants: 0 });
  assert.equal((await call('/api/registrations', { body: reg(id, '701', roster3(1)), as: T1 })).status, 201);
  const over = await call('/api/registrations', { body: reg(id, '702', roster3(1)), as: T2 });
  assert.equal(over.status, 409);
  assert.match(over.data.error, /剩 2 人，您登記了 3 人/);
  assert.equal((await call('/api/registrations', { body: reg(id, '702', roster3(1).slice(0, 2)), as: T2 })).status, 201);
  assert.match((await call('/api/registrations', { body: reg(id, '703', roster3(1).slice(0, 1)), as: 't3@st.tc.edu.tw' })).data.error, /名額已滿/);
  // 標記不參加後釋出名額
  const mine = (await call('/api/my/registrations', { as: T1 })).data.registrations[0];
  await call(`/api/registrations/${mine.id}/students/${mine.students[0].id}/withdraw`, { body: {}, as: T1 });
  assert.equal((await call('/api/registrations', { body: reg(id, '703', roster3(1).slice(0, 1)), as: 't3@st.tc.edu.tw' })).status, 201);
  const pub = (await call('/api/activities')).data.activities.find(a => a.id === id);
  assert.deepEqual([pub.max_participants, pub.overflow_mode, pub.student_count], [5, 'close', 5]);
});

test('concurrent rosters never exceed the cap in close mode', async () => {
  const { call } = setup();
  const id = await openSurvey(call, { max_participants: 5, overflow_mode: 'close', min_participants: 0 });
  const codes = ['701', '702', '703', '704', '705'];
  const res = await Promise.all(codes.map((c, i) => call('/api/registrations', { body: reg(id, c, roster3(1).slice(0, 2)), as: `c${i}@st.tc.edu.tw` })));
  assert.equal(res.filter(r => r.status === 201).length, 2);
  const adm = (await call('/api/admin/activities', { as: ADMIN })).data.activities.find(a => a.id === id);
  assert.equal(adm.student_count, 4);
});

test('capacity lottery mode: accepts over cap, draws students after deadline, once, verifiable', async () => {
  const { call, DB } = setup();
  const id = await openSurvey(call, { max_participants: 4, overflow_mode: 'lottery', min_participants: 0 });
  for (const [i, c] of ['701', '702', '703'].entries()) {
    assert.equal((await call('/api/registrations', { body: reg(id, c, roster3(1)), as: `l${i}@st.tc.edu.tw` })).status, 201);
  }
  // 一位學生標記不參加，不進入抽籤
  const first = (await call('/api/my/registrations', { as: 'l0@st.tc.edu.tw' })).data.registrations[0];
  await call(`/api/registrations/${first.id}/students/${first.students[0].id}/withdraw`, { body: {}, as: 'l0@st.tc.edu.tw' });
  assert.match((await call(`/api/admin/activities/${id}/draw`, { body: {}, as: ADMIN })).data.error, /尚未截止/);
  DB.raw.prepare(`UPDATE activities SET deadline_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(id);
  const d = await call(`/api/admin/activities/${id}/draw`, { body: {}, as: ADMIN });
  assert.equal(d.status, 200, JSON.stringify(d.data));
  assert.deepEqual([d.data.result.pool_size, d.data.result.selected_count], [8, 4]);
  assert.equal((await call(`/api/admin/activities/${id}/draw`, { body: {}, as: ADMIN })).status, 409);
  const rows = DB.raw.prepare('SELECT draw_result, COUNT(*) n FROM registration_students GROUP BY draw_result ORDER BY draw_result').all().map(r => [r.draw_result, r.n]);
  assert.deepEqual(rows, [[null, 1], ['not_selected', 4], ['selected', 4]]);
  const mine = (await call('/api/my/registrations', { as: 'l1@st.tc.edu.tw' })).data.registrations[0];
  assert.ok(mine.students.every(s => ['selected', 'not_selected'].includes(s.draw_result)));
  const pub = (await call('/api/activities')).data.activities.find(a => a.id === id);
  assert.equal(pub.selected_students, 4);
  const csv = (await call(`/api/admin/activities/${id}/registrations.csv`, { as: ADMIN })).data;
  assert.match(csv, /抽籤結果/);
  assert.equal((csv.match(/,錄取,/g) || []).length, 4);
  // 稽核：用種子重算，錄取名單一致
  const { rankPool } = await import('../src/activities.js');
  const log = JSON.parse(DB.raw.prepare(`SELECT details_json FROM audit_logs WHERE action='lottery_draw'`).get().details_json);
  const again = await rankPool(Uint8Array.from(Buffer.from(log.seed, 'hex')), log.pool.map(p => ({ id: 'student:' + p.id, class_code: p.class_code, seat_no: p.seat_no })));
  assert.deepEqual(again.slice(0, 4).map(r => `${r.class_code}-${r.seat_no}`), log.selected);
});

test('lottery mode under the cap selects everyone; close mode cannot be drawn', async () => {
  const { call, DB } = setup();
  const id = await openSurvey(call, { max_participants: 10, overflow_mode: 'lottery', min_participants: 0 });
  await call('/api/registrations', { body: reg(id, '701', roster3(1)), as: T1 });
  DB.raw.prepare(`UPDATE activities SET deadline_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(id);
  assert.equal((await call(`/api/admin/activities/${id}/draw`, { body: {}, as: ADMIN })).data.result.selected_count, 3);
  const id2 = await openSurvey(call, { title: '另一營隊', max_participants: 10, overflow_mode: 'close', min_participants: 0 });
  DB.raw.prepare(`UPDATE activities SET deadline_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(id2);
  assert.match((await call(`/api/admin/activities/${id2}/draw`, { body: {}, as: ADMIN })).data.error, /不需要抽籤/);
});

// ---------- 學生填寫（一人一筆） ----------
const stu = (id, code, seat, name, gender = '女') => ({ activity_id: id, class_code: code, teacher_name: 'x', accompany: 'yes', notes: '', students: [{ seat_no: seat, name, gender }] });

test('student fill mode: one registration per account, unique class+seat, per-class cap, self cancel', async () => {
  const { call, DB } = setup();
  const id = await openSurvey(call, { fill_mode: 'student', max_students_per_class: 2, min_participants: 0 });
  assert.equal((await call('/api/activities')).data.activities.find(a => a.id === id).fill_mode, 'student');
  // 一次只能一人
  assert.match((await call('/api/registrations', { body: reg(id, '701'), as: 's1@st.tc.edu.tw' })).data.error, /一次只能報名一人/);
  const r1 = await call('/api/registrations', { body: stu(id, '701', 3, '王小明', '男'), as: 's1@st.tc.edu.tw' });
  assert.equal(r1.status, 201, JSON.stringify(r1.data));
  // 同帳號第二次
  assert.match((await call('/api/registrations', { body: stu(id, '702', 4, '王小明'), as: 's1@st.tc.edu.tw' })).data.error, /已經報名過此營隊（701 班）/);
  // 同班同座號
  assert.match((await call('/api/registrations', { body: stu(id, '701', 3, '冒名'), as: 's2@st.tc.edu.tw' })).data.error, /701 班 3 號已經有人報名/);
  // 同班不同座號 OK，達每班上限 2 人後拒絕
  assert.equal((await call('/api/registrations', { body: stu(id, '701', 5, '李小華'), as: 's2@st.tc.edu.tw' })).status, 201);
  assert.match((await call('/api/registrations', { body: stu(id, '701', 6, '陳同學'), as: 's3@st.tc.edu.tw' })).data.error, /已達上限 2 人/);
  // 填寫人姓名＝學生姓名、submitter=student
  const row = DB.raw.prepare(`SELECT teacher_name, submitter, accompany FROM registrations WHERE teacher_email = 's1@st.tc.edu.tw'`).get();
  assert.deepEqual({ ...row }, { teacher_name: '王小明', submitter: 'student', accompany: 'no' });
  // 他人不能取消；本人可取消並重新報名
  const mine = (await call('/api/my/registrations', { as: 's1@st.tc.edu.tw' })).data.registrations[0];
  assert.equal(mine.fill_mode, 'student');
  assert.equal((await call(`/api/registrations/${mine.id}/cancel`, { body: {}, as: 's2@st.tc.edu.tw' })).status, 409);
  assert.equal((await call(`/api/registrations/${mine.id}/cancel`, { body: {}, as: 's1@st.tc.edu.tw' })).status, 200);
  assert.equal((await call(`/api/registrations/${mine.id}/cancel`, { body: {}, as: 's1@st.tc.edu.tw' })).status, 409);
  assert.equal((await call('/api/registrations', { body: stu(id, '701', 3, '王小明', '男'), as: 's1@st.tc.edu.tw' })).status, 201, 're-register after self cancel');
  // 截止後不能自行取消
  const again = (await call('/api/my/registrations', { as: 's1@st.tc.edu.tw' })).data.registrations.find(r => r.status !== 'cancelled');
  DB.raw.prepare(`UPDATE activities SET deadline_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(id);
  assert.equal((await call(`/api/registrations/${again.id}/cancel`, { body: {}, as: 's1@st.tc.edu.tw' })).status, 409);
  const adm = (await call('/api/admin/activities', { as: ADMIN })).data.activities.find(a => a.id === id);
  assert.deepEqual([adm.student_count, adm.male_count, adm.female_count], [2, 1, 1]);
  const csv = (await call(`/api/admin/activities/${id}/registrations.csv`, { as: ADMIN })).data;
  assert.match(csv, /填寫人/);
});

test('teacher fill mode cannot self-cancel; fill mode locked once registrations exist', async () => {
  const { call } = setup();
  const id = await openSurvey(call, { min_participants: 0 });
  const r = await call('/api/registrations', { body: reg(id, '701'), as: T1 });
  assert.equal((await call(`/api/registrations/${r.data.registration.id}/cancel`, { body: {}, as: T1 })).status, 409);
  // 兩個導師填寫的班仍不能重複
  assert.equal((await call('/api/registrations', { body: reg(id, '701'), as: T2 })).status, 409);
  const cur = (await call('/api/admin/activities', { as: ADMIN })).data.activities.find(a => a.id === id);
  const res = await call(`/api/admin/activities/${id}`, { method: 'PUT', body: { ...surveyBody({ min_participants: 0, fill_mode: 'student' }), base: cur }, as: ADMIN });
  assert.equal(res.status, 409);
  assert.match(res.data.error, /不能切換填寫方式/);
});

test('concurrent student submissions for the same seat: only one succeeds', async () => {
  const { call } = setup();
  const id = await openSurvey(call, { fill_mode: 'student', min_participants: 0 });
  const res = await Promise.all([1, 2, 3].map(i => call('/api/registrations', { body: stu(id, '801', 7, '同學' + i), as: `c${i}@st.tc.edu.tw` })));
  assert.deepEqual(res.map(r => r.status).sort(), [201, 409, 409]);
});

// ---------- 免登入自由報名（自填 Email） ----------
const pub = (id, over = {}) => ({ activity_id: id, class_code: '701', seat_no: 3, name: '王小明', gender: '男', email: 'Kid@Gmail.com', notes: '', ...over });

test('open registration: no login, email kept unverified, dedupe by email and seat, cancel by email+class+seat', async () => {
  const { call, DB } = setup();
  const id = await openSurvey(call, { fill_mode: 'open', max_students_per_class: 30, min_participants: 0 });
  const act = (await call('/api/activities')).data.activities.find(a => a.id === id);
  assert.deepEqual([act.fill_mode, act.login_required], ['student', 0]);

  const r = await call('/api/public/registrations', { body: pub(id) });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.cancel_code, undefined, 'no cancel code any more');
  const row = DB.raw.prepare('SELECT teacher_email, teacher_name, submitter, verified FROM registrations').get();
  assert.deepEqual([row.teacher_email, row.teacher_name, row.submitter, row.verified], ['kid@gmail.com', '王小明', 'student', 0]);

  assert.match((await call('/api/public/registrations', { body: pub(id, { seat_no: 4 }) })).data.error, /這個 Email 已經報名過/);
  assert.match((await call('/api/public/registrations', { body: pub(id, { email: 'other@gmail.com' }) })).data.error, /701 班 3 號已經有人報名/);
  assert.match((await call('/api/public/registrations', { body: pub(id, { email: 'bad' }) })).data.error, /Email/);
  assert.equal((await call('/api/public/registrations', { body: pub(id, { email: 'bot@x.com', seat_no: 9, website: 'http://spam' }) })).status, 400, 'honeypot');

  // 取消：Email、班級、座號必須都相符
  const cancel = over => call('/api/public/registrations/cancel', { body: { activity_id: id, email: 'kid@gmail.com', class_code: '701', seat_no: 3, ...over } });
  assert.equal((await cancel({ seat_no: 4 })).status, 409);
  assert.equal((await cancel({ class_code: '702' })).status, 409);
  assert.equal((await cancel({ email: 'other@gmail.com' })).status, 409);
  assert.equal((await cancel({ email: 'KID@Gmail.com' })).status, 200);
  assert.equal((await cancel({})).status, 409, 'already cancelled');
  assert.equal((await call('/api/public/registrations', { body: pub(id) })).status, 201, 're-register after cancel');
  // 截止後不能取消
  DB.raw.prepare(`UPDATE activities SET deadline_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(id);
  assert.equal((await cancel({})).status, 409);
  const list = (await call(`/api/admin/activities/${id}/registrations`, { as: ADMIN })).data.registrations;
  assert.ok(list.every(x => x.verified === 0));
});

test('class count ignores registrations whose students are all withdrawn', async () => {
  const { call } = setup();
  const id = await openSurvey(call, { min_participants: 0 });
  await call('/api/registrations', { body: reg(id, '701', [{ seat_no: 1, name: 'A', gender: '男' }]), as: T1 });
  await call('/api/registrations', { body: reg(id, '702', [{ seat_no: 2, name: 'B', gender: '女' }]), as: T2 });
  const mine = (await call('/api/my/registrations', { as: T1 })).data.registrations[0];
  await call(`/api/registrations/${mine.id}/students/${mine.students[0].id}/withdraw`, { body: {}, as: T1 });
  assert.equal((await call('/api/activities')).data.activities.find(a => a.id === id).registered_count, 1);
  assert.equal((await call('/api/admin/activities', { as: ADMIN })).data.activities.find(a => a.id === id).registered_count, 1);
});

test('lottery overflow requires a participant cap', async () => {
  const { call } = setup();
  const res = await call('/api/admin/activities', { body: surveyBody({ overflow_mode: 'lottery', max_participants: 0, min_participants: 0 }), as: ADMIN });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /請填寫人數上限/);
});

test('open registration is refused for activities that require login', async () => {
  const { call } = setup();
  const loginStudent = await openSurvey(call, { fill_mode: 'student', min_participants: 0 });
  const teacherFill = await openSurvey(call, { title: '導師填寫營隊', min_participants: 0 });
  assert.equal((await call('/api/public/registrations', { body: pub(loginStudent) })).status, 404);
  assert.equal((await call('/api/public/registrations', { body: pub(teacherFill) })).status, 404);
});

test('open mode cannot be switched once registrations exist', async () => {
  const { call } = setup();
  const id = await openSurvey(call, { fill_mode: 'open', min_participants: 0 });
  await call('/api/public/registrations', { body: pub(id) });
  const cur = (await call('/api/admin/activities', { as: ADMIN })).data.activities.find(a => a.id === id);
  const res = await call(`/api/admin/activities/${id}`, { method: 'PUT', body: { ...surveyBody({ min_participants: 0, fill_mode: 'student' }), base: cur }, as: ADMIN });
  assert.match(res.data.error, /不能切換填寫方式/);
});

test('manual backfill after survey lottery: next by draw rank, one per click, restore cannot overfill', async () => {
  const { call, DB } = setup();
  const id = await openSurvey(call, { max_participants: 3, overflow_mode: 'lottery', min_participants: 0 });
  for (const [i, c] of ['701', '702'].entries()) await call('/api/registrations', { body: reg(id, c, roster3(1)), as: `b${i}@st.tc.edu.tw` });
  const path = `/api/admin/activities/${id}/backfill`;
  assert.match((await call(path, { body: {}, as: ADMIN })).data.error, /尚未抽籤/);
  DB.raw.prepare(`UPDATE activities SET deadline_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(id);
  await call(`/api/admin/activities/${id}/draw`, { body: {}, as: ADMIN });
  assert.equal((await call(path, { body: {}, as: 'b0@st.tc.edu.tw' })).status, 403);
  assert.match((await call(path, { body: {}, as: ADMIN })).data.error, /沒有空出的名額/);
  const sel = DB.raw.prepare(`SELECT id, registration_id FROM registration_students WHERE draw_result='selected' ORDER BY draw_rank`).all();
  const next = DB.raw.prepare(`SELECT id FROM registration_students WHERE draw_result='not_selected' ORDER BY draw_rank`).all().map(r => r.id);
  // 一位錄取者不參加 → 同時按兩次只遞補一位，為抽籤序最前的未錄取者
  assert.equal((await call(`/api/registrations/${sel[0].registration_id}/students/${sel[0].id}/withdraw`, { body: {}, as: ADMIN })).status, 200);
  const res = await Promise.all([1, 2].map(() => call(path, { body: {}, as: ADMIN })));
  assert.deepEqual(res.map(r => r.status).sort(), [200, 409]);
  const ok = res.find(r => r.status === 200).data.result;
  assert.deepEqual([ok.vacancies, ok.waiting], [0, 2]);
  const promoted = DB.raw.prepare(`SELECT id, backfilled_at FROM registration_students WHERE backfilled_at IS NOT NULL`).all();
  assert.deepEqual(promoted.map(r => r.id), [next[0]]);
  assert.equal(DB.raw.prepare(`SELECT COUNT(*) n FROM registration_students WHERE status='active' AND draw_result='selected'`).get().n, 3);
  assert.equal(DB.raw.prepare(`SELECT COUNT(*) n FROM audit_logs WHERE action='lottery_backfill'`).get().n, 1);
  // 原錄取者恢復參加會超過上限 → 拒絕
  assert.match((await call(`/api/admin/registrations/${sel[0].registration_id}/students/${sel[0].id}/restore`, { body: {}, as: ADMIN })).data.error, /遞補/);
  const csv = (await call(`/api/admin/activities/${id}/registrations.csv`, { as: ADMIN })).data;
  assert.equal((csv.match(/錄取（遞補）/g) || []).length, 1);
  // 候選者全數不參加 → 沒有可遞補者
  for (const s of DB.raw.prepare(`SELECT id, registration_id FROM registration_students WHERE draw_result='not_selected'`).all()) {
    await call(`/api/registrations/${s.registration_id}/students/${s.id}/withdraw`, { body: {}, as: ADMIN });
  }
  await call(`/api/registrations/${sel[1].registration_id}/students/${sel[1].id}/withdraw`, { body: {}, as: ADMIN });
  assert.match((await call(path, { body: {}, as: ADMIN })).data.error, /沒有可遞補的候選者/);
});

test('refund: only paid students who withdrew / were not selected / cancelled; paid cannot be unset while refunded', async () => {
  const { call, DB } = setup();
  const id = await openSurvey(call, { min_participants: 0 });
  await call('/api/registrations', { body: reg(id, '701'), as: T1 });
  const r = (await call('/api/my/registrations', { as: T1 })).data.registrations[0];
  const [a, b] = r.students;
  const P = (sid, path, body) => call(`/api/admin/registrations/${r.id}/students/${sid}/${path}`, { body, as: ADMIN });
  assert.equal((await P(a.id, 'refund', { refunded: true })).status, 409, 'not paid');
  assert.equal((await P(a.id, 'paid', { paid: true })).status, 200);
  assert.equal((await P(a.id, 'refund', { refunded: true })).status, 409, 'still participating');
  assert.equal((await P(a.id, 'refund', { refunded: true }).then(() => call(`/api/registrations/${r.id}/students/${a.id}/withdraw`, { body: {}, as: T1 }))).status, 200);
  let csv = (await call(`/api/admin/activities/${id}/registrations.csv`, { as: ADMIN })).data;
  assert.match(csv, /已繳（待退費）/);
  assert.equal((await call(`/api/admin/registrations/${r.id}/students/${a.id}/refund`, { body: { refunded: true }, as: T1 })).status, 403);
  assert.equal((await P(a.id, 'refund', { refunded: true })).status, 200);
  assert.match((await P(a.id, 'paid', { paid: false })).data.error, /退費/);
  csv = (await call(`/api/admin/activities/${id}/registrations.csv`, { as: ADMIN })).data;
  assert.match(csv, /,已退費,/);
  // 整班取消 → 已繳者可登記退費
  await P(b.id, 'paid', { paid: true });
  await call(`/api/admin/activities/${id}/registrations/${r.id}/cancel`, { body: { reason: 'x' }, as: ADMIN });
  assert.equal((await P(b.id, 'refund', { refunded: true })).status, 200);
  const actions = DB.raw.prepare(`SELECT action FROM audit_logs WHERE action LIKE 'student_refund%' ORDER BY id`).all().map(x => x.action);
  assert.deepEqual(actions, ['student_refunded', 'student_refunded']);
});

test('open lookup: needs email + class + seat, returns only own masked result through draw and backfill', async () => {
  const { call, DB } = setup();
  const id = await openSurvey(call, { fill_mode: 'open', max_students_per_class: 30, min_participants: 0, max_participants: 1, overflow_mode: 'lottery' });
  assert.equal((await call('/api/public/registrations', { body: pub(id) })).status, 201);
  assert.equal((await call('/api/public/registrations', { body: pub(id, { email: 'b@gmail.com', seat_no: 4, name: '李四' }) })).status, 201);
  const look = over => call('/api/public/registrations/lookup', { body: { activity_id: id, email: 'kid@gmail.com', class_code: '701', seat_no: 3, ...over } });
  assert.equal((await look({ seat_no: 4 })).status, 404, 'seat must match the email');
  assert.equal((await look({ email: 'b@gmail.com' })).status, 404);
  assert.equal((await look({ email: '' })).status, 400);
  const before = (await look()).data.result;
  assert.deepEqual([before.result, before.name], ['waiting_draw', '王○明']);
  assert.equal(JSON.stringify(before).includes('kid@'), false);
  DB.raw.prepare(`UPDATE activities SET deadline_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(id);
  await call(`/api/admin/activities/${id}/draw`, { body: {}, as: ADMIN });
  const a = (await look()).data.result.result, b = (await look({ email: 'B@gmail.com', seat_no: 4 })).data.result.result;
  assert.deepEqual([a, b].sort(), ['not_selected', 'selected']);
  // 錄取者不參加 → 遞補後另一位顯示「錄取（遞補）」
  const win = DB.raw.prepare(`SELECT s.id, s.registration_id FROM registration_students s WHERE draw_result = 'selected'`).get();
  await call(`/api/registrations/${win.registration_id}/students/${win.id}/withdraw`, { body: {}, as: ADMIN });
  await call(`/api/admin/activities/${id}/backfill`, { body: {}, as: ADMIN });
  const after = [(await look()).data.result.result, (await look({ email: 'b@gmail.com', seat_no: 4 })).data.result.result].sort();
  assert.deepEqual(after, ['selected_backfill', 'withdrawn']);
});

// ---------- 邏輯檢查修正 ----------
test('restore after lottery: student withdrawn before the draw joins the end of the waiting list', async () => {
  const { call, DB } = setup();
  const id = await openSurvey(call, { max_participants: 2, overflow_mode: 'lottery', min_participants: 0 });
  await call('/api/registrations', { body: reg(id, '701', roster3(1)), as: T1 });
  const r = (await call('/api/my/registrations', { as: T1 })).data.registrations[0];
  const early = r.students[0];
  await call(`/api/registrations/${r.id}/students/${early.id}/withdraw`, { body: {}, as: T1 });
  DB.raw.prepare(`UPDATE activities SET deadline_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(id);
  await call(`/api/admin/activities/${id}/draw`, { body: {}, as: ADMIN });
  assert.equal((await call(`/api/admin/registrations/${r.id}/students/${early.id}/restore`, { body: {}, as: ADMIN })).status, 200);
  const s = DB.raw.prepare(`SELECT draw_result, draw_rank FROM registration_students WHERE id = ?`).get(early.id);
  assert.deepEqual([s.draw_result, s.draw_rank], ['not_selected', 3]);
});

test('restore in close mode cannot exceed the cap', async () => {
  const { call } = setup();
  const id = await openSurvey(call, { max_participants: 3, overflow_mode: 'close', min_participants: 0 });
  await call('/api/registrations', { body: reg(id, '701', roster3(1)), as: T1 });
  const r = (await call('/api/my/registrations', { as: T1 })).data.registrations[0];
  await call(`/api/registrations/${r.id}/students/${r.students[0].id}/withdraw`, { body: {}, as: T1 });
  assert.equal((await call('/api/registrations', { body: reg(id, '702', roster3(1).slice(0, 1)), as: T2 })).status, 201);
  const res = await call(`/api/admin/registrations/${r.id}/students/${r.students[0].id}/restore`, { body: {}, as: ADMIN });
  assert.match(res.data.error, /名額已滿/);
});

test('refunded student promoted by backfill: flagged for re-payment; lookup shows unpaid', async () => {
  const { call, DB } = setup();
  const id = await openSurvey(call, { fill_mode: 'open', max_students_per_class: 30, min_participants: 0, max_participants: 1, overflow_mode: 'lottery' });
  await call('/api/public/registrations', { body: pub(id) });
  await call('/api/public/registrations', { body: pub(id, { email: 'b@gmail.com', seat_no: 4, name: '李四' }) });
  DB.raw.prepare(`UPDATE activities SET deadline_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(id);
  await call(`/api/admin/activities/${id}/draw`, { body: {}, as: ADMIN });
  const st = DB.raw.prepare(`SELECT s.id, s.registration_id, s.draw_result FROM registration_students s ORDER BY draw_rank`).all();
  const [win, lose] = st;
  const P = (s, p, b) => call(`/api/admin/registrations/${s.registration_id}/students/${s.id}/${p}`, { body: b, as: ADMIN });
  await P(lose, 'paid', { paid: true });
  assert.equal((await P(lose, 'refund', { refunded: true })).status, 200);
  await call(`/api/registrations/${win.registration_id}/students/${win.id}/withdraw`, { body: {}, as: ADMIN });
  const b = await call(`/api/admin/activities/${id}/backfill`, { body: {}, as: ADMIN });
  assert.equal(b.data.result.promoted.refunded, 1);
  const csv = (await call(`/api/admin/activities/${id}/registrations.csv`, { as: ADMIN })).data;
  assert.match(csv, /需重新收費/);
  const loseEmail = DB.raw.prepare(`SELECT teacher_email, class_code FROM registrations WHERE id = ?`).get(lose.registration_id);
  const seat = DB.raw.prepare(`SELECT seat_no FROM registration_students WHERE id = ?`).get(lose.id).seat_no;
  const look = (await call('/api/public/registrations/lookup', { body: { activity_id: id, email: loseEmail.teacher_email, class_code: loseEmail.class_code, seat_no: seat } })).data.result;
  assert.deepEqual([look.result, look.paid], ['selected_backfill', false]);
});

test('a seat marked 不參加 cannot be taken by another email', async () => {
  const { call, DB } = setup();
  const id = await openSurvey(call, { fill_mode: 'open', max_students_per_class: 30, min_participants: 0 });
  await call('/api/public/registrations', { body: pub(id) });
  const s = DB.raw.prepare(`SELECT id, registration_id FROM registration_students`).get();
  await call(`/api/registrations/${s.registration_id}/students/${s.id}/withdraw`, { body: {}, as: ADMIN });
  assert.match((await call('/api/public/registrations', { body: pub(id, { email: 'x@gmail.com' }) })).data.error, /701 班 3 號已經有人報名/);
  // 整筆取消後才釋出座號
  DB.raw.prepare(`UPDATE registrations SET status = 'cancelled'`).run();
  assert.equal((await call('/api/public/registrations', { body: pub(id, { email: 'x@gmail.com' }) })).status, 201);
});

// ---------- 營隊開班與候補 ----------
test('sections: section size × max sections sets the cap; waitlist needs a cap', async () => {
  const { validateActivity } = await import('../src/activities.js');
  const a = validateActivity(surveyBody({ section_size: 30, max_sections: 2, overflow_mode: 'waitlist', min_participants: 20 }));
  assert.deepEqual([a.max_participants, a.waitlist, a.overflow_mode], [60, 1, 'close']);
  assert.throws(() => validateActivity(surveyBody({ section_size: 30, max_sections: 0, overflow_mode: 'waitlist', min_participants: 0 })), /額滿改候補/);
  assert.equal(validateActivity(surveyBody({ section_size: 30, min_participants: 0 })).max_participants, 0, 'no max sections = no cap');
});

test('waitlist: over the cap is accepted as 候補 in order, auto-promoted when someone withdraws or cancels', async () => {
  const { call, DB } = setup();
  const id = await openSurvey(call, { fill_mode: 'open', max_students_per_class: 30, min_participants: 0, section_size: 2, max_sections: 1, overflow_mode: 'waitlist' });
  for (let seat = 1; seat <= 4; seat++) {
    const r = await call('/api/public/registrations', { body: pub(id, { email: `k${seat}@gmail.com`, seat_no: seat, name: '學生' + seat }) });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  }
  const look = seat => call('/api/public/registrations/lookup', { body: { activity_id: id, email: `k${seat}@gmail.com`, class_code: '701', seat_no: seat } }).then(r => r.data.result);
  assert.deepEqual([(await look(1)).result, (await look(2)).result, (await look(3)).result, (await look(4)).result], ['registered', 'registered', 'waitlisted', 'waitlisted']);
  assert.equal((await look(4)).waitlist_no, 2);
  // 正取者標記不參加 → 候補第 1 位自動遞補
  const s1 = DB.raw.prepare(`SELECT s.id, s.registration_id FROM registration_students s WHERE seat_no = 1`).get();
  await call(`/api/registrations/${s1.registration_id}/students/${s1.id}/withdraw`, { body: {}, as: ADMIN });
  assert.equal((await look(3)).result, 'registered');
  assert.deepEqual([(await look(4)).result, (await look(4)).waitlist_no], ['waitlisted', 1]);
  // 額滿時不能恢復參加（避免把已遞補的人擠回候補）
  assert.match((await call(`/api/admin/registrations/${s1.registration_id}/students/${s1.id}/restore`, { body: {}, as: ADMIN })).data.error, /名額已滿/);
  // 整筆取消也會遞補
  assert.equal((await call('/api/public/registrations/cancel', { body: { activity_id: id, email: 'k2@gmail.com', class_code: '701', seat_no: 2 } })).status, 200);
  assert.equal((await look(4)).result, 'registered');
  // 名單與 CSV 標示
  const list = (await call(`/api/admin/activities/${id}/registrations`, { as: ADMIN })).data.registrations;
  assert.ok(list.flatMap(r => r.students).every(s => s.waitlist_no === 0));
  const csv = (await call(`/api/admin/activities/${id}/registrations.csv`, { as: ADMIN })).data;
  assert.match(csv, /正取／候補/);
  assert.equal((csv.match(/,正取,/g) || []).length, 2);
});

test('frontend: a full waitlist camp stays open for registration and cancellation', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const isFull = new Function(src.match(/function isFull\(a\)\{[^}]*\}/)[0] + ';return isFull;')();
  const base = { kind: 'survey', overflow_mode: 'close', max_participants: 30, student_count: 34 };
  assert.equal(isFull({ ...base, waitlist: 0 }), true);
  assert.equal(isFull({ ...base, waitlist: 1 }), false);
});

// ---------- 繳費單 ----------
test('payment slips: admin or the organizer only; only 正取 participants; free camps refused', async () => {
  const { call, DB } = setup();
  const ORG = 'org@st.tc.edu.tw';
  const id = await openSurvey(call, { fill_mode: 'open', max_students_per_class: 30, min_participants: 0, fee: 300, organizer_email: ORG,
    pay_due: '2026-11-06', pay_info: '交給導師', section_size: 2, max_sections: 1, overflow_mode: 'waitlist' });
  for (let seat = 1; seat <= 3; seat++) await call('/api/public/registrations', { body: pub(id, { email: `p${seat}@gmail.com`, seat_no: seat, name: '生' + seat }) });
  const path = `/api/activities/${id}/payment-slips`;
  assert.equal((await call(path)).status, 401);
  assert.equal((await call(path, { as: T1 })).status, 403, 'other teachers cannot');
  const org = await call(path, { as: ORG });
  assert.equal(org.status, 200, JSON.stringify(org.data));
  assert.deepEqual(org.data.students.map(s => s.seat_no), [1, 2], 'waitlisted student 3 is excluded');
  assert.deepEqual([org.data.activity.fee, org.data.activity.pay_due, org.data.activity.pay_info], [300, '2026-11-06', '交給導師']);
  assert.equal((await call(path, { as: ADMIN })).status, 200);
  assert.deepEqual((await call('/api/my/organized', { as: ORG })).data.activities.map(a => a.id), [id]);
  assert.deepEqual((await call('/api/my/organized', { as: T1 })).data.activities, []);
  const free = await openSurvey(call, { min_participants: 0, fee: 0 });
  assert.match((await call(`/api/activities/${free}/payment-slips`, { as: ADMIN })).data.error, /免費/);
  assert.match((await call('/api/admin/activities', { body: surveyBody({ pay_due: '11/6' }), as: ADMIN })).data.error, /繳費期限/);
  void DB;
});
