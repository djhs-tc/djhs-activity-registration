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
