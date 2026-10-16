// 報名、管理與抽籤：以 node:sqlite 執行真正的 schema.sql 與 SQL。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './d1-shim.mjs';
import { signSession } from '../src/auth.js';
import { taipeiToUtcIso } from '../src/http.js';
import { register, drawLottery, rankPool, toCsv, validateActivity, listRegistrations, cancelRegistration, updateActivity } from '../src/activities.js';
import worker from '../src/index.js';

const CLIENT_ID = '123456789-abcdef.apps.googleusercontent.com';
const SECRET = 's'.repeat(40);
const ADMIN = 'tjjh111@tjjh.tc.edu.tw';
const ORIGIN = 'https://djhs.test';

function setup() {
  const DB = createD1();
  const env = { DB, ASSETS: { fetch: async () => new Response('asset') }, GOOGLE_CLIENT_ID: CLIENT_ID, SESSION_SECRET: SECRET, ADMIN_EMAILS: ADMIN, ALLOWED_EMAIL_DOMAINS: 'st.tc.edu.tw,tjjh.tc.edu.tw' };
  const ctx = { waitUntil() {} };
  async function call(path, { method = 'GET', body, as } = {}) {
    const headers = {};
    if (as) headers.cookie = '__Host-djhs_session=' + await signSession({ email: as, name: 'n' }, SECRET);
    if (body !== undefined) { headers['content-type'] = 'application/json'; headers.origin = ORIGIN; }
    const res = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch (_) { data = text; }
    return { status: res.status, data, headers: res.headers };
  }
  return { DB, env, call };
}

// 以「現在」為基準產生臺灣時間的日期/時間欄位
function tp(offsetMin) {
  const d = new Date(Date.now() + 8 * 3600e3 + offsetMin * 60e3).toISOString();
  return { date: d.slice(0, 10), time: d.slice(11, 16) };
}
function activityBody(over = {}) {
  const s = tp(60 * 24 * 7), e = tp(60 * 24 * 7 + 120), o = tp(-60), d = tp(60);
  return {
    title: '自律學習力', speaker: '陳怡嘉老師', venue: '鎮瀾文化大樓', audience: '七、八、九年級', description: '',
    starts_date: s.date, starts_time: s.time, ends_date: e.date, ends_time: e.time,
    opens_date: o.date, opens_time: o.time, deadline_date: d.date, deadline_time: d.time,
    priority_quota: 15, lottery_quota: 3, organizer_name: '教學組長', organizer_email: 'tjjh111@tjjh.tc.edu.tw', ...over
  };
}
const reg = (activity_id, class_code, over = {}) => ({ activity_id, class_code, teacher_name: '王老師', accompany: 'yes', notes: '', ...over });
const teacher = i => `t${i}@st.tc.edu.tw`;

async function openActivity(call, over) {
  const created = await call('/api/admin/activities', { method: 'POST', body: activityBody(over), as: ADMIN });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.activity.id;
  assert.equal((await call(`/api/admin/activities/${id}/status`, { method: 'POST', body: { status: 'open' }, as: ADMIN })).status, 200);
  return id;
}

test('taipeiToUtcIso converts Asia/Taipei and rejects invalid dates', () => {
  assert.equal(taipeiToUtcIso('2026-10-16', '08:00'), '2026-10-16T00:00:00.000Z');
  assert.equal(taipeiToUtcIso('2026-11-06', '12:00'), '2026-11-06T04:00:00.000Z');
  assert.equal(taipeiToUtcIso('2026-11-12', '06:30'), '2026-11-11T22:30:00.000Z');
  for (const [d, t] of [['2026-02-30', '08:00'], ['2026-10-16', '24:00'], ['2026/10/16', '08:00'], ['2026-10-16', '8:00'], ['', '']]) {
    assert.equal(taipeiToUtcIso(d, t), null, d + ' ' + t);
  }
});

test('activity validation rejects inconsistent schedules', () => {
  assert.throws(() => validateActivity(activityBody({ title: '' })), /活動名稱/);
  const b = activityBody();
  assert.throws(() => validateActivity(activityBody({ ends_date: b.starts_date, ends_time: b.starts_time })), /結束時間/);
  assert.throws(() => validateActivity(activityBody({ opens_date: '2026-10-16', opens_time: '08:00', deadline_date: '2026-10-16', deadline_time: '07:59' })), /截止時間必須晚於開放/);
  assert.throws(() => validateActivity(activityBody({ priority_quota: -1 })), /優先錄取名額/);
  assert.throws(() => validateActivity(activityBody({ lottery_quota: 2.5 })), /抽籤名額/);
  const late = tp(60 * 24 * 8);
  assert.throws(() => validateActivity(activityBody({ deadline_date: late.date, deadline_time: late.time })), /不可晚於活動開始/);
});

test('permissions: anonymous 401, teacher 403 on admin APIs, cross-site 403', async () => {
  const { call } = setup();
  assert.equal((await call('/api/admin/activities')).status, 401);
  assert.equal((await call('/api/admin/activities', { as: teacher(1) })).status, 403);
  assert.equal((await call('/api/admin/activities', { method: 'POST', body: activityBody(), as: teacher(1) })).status, 403);
  assert.equal((await call('/api/registrations', { method: 'POST', body: reg('x', '701') })).status, 401);
  assert.equal((await call('/api/my/registrations')).status, 401);
  const id = await openActivity(call);
  assert.equal((await call(`/api/admin/activities/${id}/draw`, { method: 'POST', body: {}, as: teacher(1) })).status, 403);
  assert.equal((await call(`/api/admin/activities/${id}/registrations.csv`, { as: teacher(1) })).status, 403);
});

test('draft activity is hidden and not open for registration; editable after opening', async () => {
  const { call } = setup();
  const created = await call('/api/admin/activities', { method: 'POST', body: activityBody(), as: ADMIN });
  const id = created.data.activity.id;
  assert.equal(created.data.activity.status, 'draft');
  assert.equal(created.data.activity.opens_at.endsWith('Z'), true);
  assert.deepEqual((await call('/api/activities')).data.activities, []);
  assert.equal((await call('/api/registrations', { method: 'POST', body: reg(id, '701'), as: teacher(1) })).status, 404);
  assert.equal((await call(`/api/admin/activities/${id}`, { method: 'PUT', body: activityBody({ title: '改名' }), as: ADMIN })).data.activity.title, '改名');
  await call(`/api/admin/activities/${id}/status`, { method: 'POST', body: { status: 'open' }, as: ADMIN });
  const edited = await call(`/api/admin/activities/${id}`, { method: 'PUT', body: activityBody({ venue: '大禮堂' }), as: ADMIN });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.activity.venue, '大禮堂');
  assert.equal(edited.data.activity.status, 'open');
  assert.equal((await call(`/api/admin/activities/${id}/status`, { method: 'POST', body: { status: 'drawn' }, as: ADMIN })).status, 409);
  assert.equal((await call('/api/activities')).data.activities.length, 1);
});

test('first 15 classes get priority, rest go to lottery pool; duplicates rejected', async () => {
  const { call } = setup();
  const id = await openActivity(call);
  const results = [];
  for (let i = 1; i <= 18; i++) {
    const code = String(700 + i);
    const r = await call('/api/registrations', { method: 'POST', body: reg(id, code), as: teacher(i) });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    results.push(r.data.registration.status);
  }
  assert.deepEqual(results, [...Array(15).fill('priority'), 'lottery_pool', 'lottery_pool', 'lottery_pool']);
  const dup = await call('/api/registrations', { method: 'POST', body: reg(id, '701'), as: teacher(99) });
  assert.equal(dup.status, 409);
  assert.match(dup.data.error, /701 班已經報名/);
  const pub = (await call('/api/activities')).data.activities[0];
  assert.equal(pub.registered_count, 18);
  const mine = await call('/api/my/registrations', { as: teacher(3) });
  assert.equal(mine.data.registrations.length, 1);
  assert.equal(mine.data.registrations[0].class_code, '703');
  assert.equal(mine.data.registrations[0].title, '自律學習力');
});

test('concurrent submissions never exceed the priority quota', async () => {
  const { call } = setup();
  const id = await openActivity(call, { priority_quota: 15 });
  const codes = [];
  for (const g of [7, 8, 9]) for (let c = 1; c <= 10; c++) codes.push(`${g}${String(c).padStart(2, '0')}`);
  const res = await Promise.all(codes.map((code, i) => call('/api/registrations', { method: 'POST', body: reg(id, code), as: teacher(i) })));
  assert.ok(res.every(r => r.status === 201));
  const statuses = res.map(r => r.data.registration.status);
  assert.equal(statuses.filter(s => s === 'priority').length, 15);
  assert.equal(statuses.filter(s => s === 'lottery_pool').length, 15);
  // 同一班同時送出兩次：只會成功一次
  const twice = await Promise.all([1, 2].map(i => call('/api/registrations', { method: 'POST', body: reg(id, '930'), as: teacher(100 + i) })));
  assert.deepEqual(twice.map(r => r.status).sort(), [201, 409]);
});

test('input validation on registration', async () => {
  const { call } = setup();
  const id = await openActivity(call);
  for (const [body, re] of [
    [reg(id, '601'), /班級格式/], [reg(id, '731'), /班級格式/], [reg(id, '70'), /班級格式/],
    [reg(id, '701', { teacher_name: '' }), /導師姓名/], [reg(id, '701', { accompany: 'maybe' }), /隨班/],
    [reg(id, '701', { notes: 'x'.repeat(201) }), /備註/]
  ]) {
    const r = await call('/api/registrations', { method: 'POST', body, as: teacher(1) });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.data.error, re);
  }
});

test('registration window boundaries use server time', async () => {
  const DB = createD1();
  const a = validateActivity(activityBody());
  DB.raw.prepare(`INSERT INTO activities (id,title,starts_at,ends_at,opens_at,deadline_at,priority_quota,lottery_quota,status,created_by)
    VALUES ('A','t',?,?,?,?,15,3,'open','x')`).run(a.starts_at, a.ends_at, '2026-10-16T00:00:00.000Z', '2026-11-06T04:00:00.000Z');
  const user = { email: teacher(1) };
  const input = c => ({ activityId: 'A', classCode: c, teacherName: 'n', accompany: 'no', notes: '' });
  await assert.rejects(register(DB, user, input('701'), '2026-10-15T23:59:59.999Z'), /尚未開放/);
  assert.equal((await register(DB, user, input('701'), '2026-10-16T00:00:00.000Z')).status, 'priority');
  assert.equal((await register(DB, user, input('702'), '2026-11-06T03:59:59.999Z')).status, 'priority');
  await assert.rejects(register(DB, user, input('703'), '2026-11-06T04:00:00.000Z'), /截止/);
});

test('lottery: only after deadline, picks lottery_quota from pool, cannot run twice, verifiable', async () => {
  const DB = createD1();
  DB.raw.prepare(`INSERT INTO activities (id,title,starts_at,ends_at,opens_at,deadline_at,priority_quota,lottery_quota,status,created_by)
    VALUES ('A','t','2026-11-12T06:00:00.000Z','2026-11-12T08:00:00.000Z','2026-10-16T00:00:00.000Z','2026-11-06T04:00:00.000Z',15,3,'open','x')`).run();
  for (let i = 1; i <= 22; i++) {
    await register(DB, { email: teacher(i) }, { activityId: 'A', classCode: String(700 + i), teacherName: 'n', accompany: 'no', notes: '' }, '2026-10-20T00:00:00.000Z');
  }
  const admin = { email: ADMIN };
  await assert.rejects(drawLottery(DB, admin, 'A', '2026-11-06T03:59:59.000Z'), /尚未截止/);
  const seed = new Uint8Array(32).fill(7);
  const result = await drawLottery(DB, admin, 'A', '2026-11-06T04:00:00.000Z', seed);
  assert.equal(result.pool_size, 7);
  assert.equal(result.selected.length, 3);
  await assert.rejects(drawLottery(DB, admin, 'A', '2026-11-06T05:00:00.000Z'), /已經抽過籤/);

  const rows = await listRegistrations(DB, 'A');
  const by = s => rows.filter(r => r.status === s);
  assert.equal(by('priority').length, 15);
  assert.equal(by('selected').length, 3);
  assert.equal(by('not_selected').length, 4);
  assert.equal(by('lottery_pool').length, 0);
  assert.deepEqual(by('selected').map(r => r.class_code).sort(), [...result.selected].sort());
  assert.equal(DB.raw.prepare(`SELECT status FROM activities WHERE id='A'`).get().status, 'drawn');

  // 稽核：用紀錄中的種子重算，結果一致
  const log = JSON.parse(DB.raw.prepare(`SELECT details_json FROM audit_logs WHERE action='lottery_draw'`).get().details_json);
  const pool = rows.filter(r => ['selected', 'not_selected'].includes(r.status)).map(r => ({ id: r.id, class_code: r.class_code }));
  const recomputed = await rankPool(Uint8Array.from(Buffer.from(log.seed, 'hex')), pool);
  assert.deepEqual(recomputed.slice(0, 3).map(r => r.class_code), log.selected);
  assert.equal(DB.raw.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action='lottery_draw'`).get().n, 1);

  // 抽籤後不能再報名
  await assert.rejects(register(DB, { email: 'z@st.tc.edu.tw' }, { activityId: 'A', classCode: '930', teacherName: 'n', accompany: 'no', notes: '' }, '2026-11-06T03:00:00.000Z'), /截止/);
});

test('concurrent lottery draws: exactly one succeeds', async () => {
  const DB = createD1();
  DB.raw.prepare(`INSERT INTO activities (id,title,starts_at,ends_at,opens_at,deadline_at,priority_quota,lottery_quota,status,created_by)
    VALUES ('A','t','2026-11-12T06:00:00.000Z','2026-11-12T08:00:00.000Z','2026-10-16T00:00:00.000Z','2026-11-06T04:00:00.000Z',1,1,'open','x')`).run();
  for (let i = 1; i <= 4; i++) await register(DB, { email: teacher(i) }, { activityId: 'A', classCode: String(800 + i), teacherName: 'n', accompany: 'no', notes: '' }, '2026-10-20T00:00:00.000Z');
  const res = await Promise.allSettled([1, 2, 3].map(i => drawLottery(DB, { email: ADMIN }, 'A', `2026-11-07T00:00:0${i}.000Z`)));
  assert.equal(res.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(DB.raw.prepare(`SELECT COUNT(*) AS n FROM registrations WHERE status='selected'`).get().n, 1);
});

test('fewer pool entries than quota: all selected; empty pool still marks drawn', async () => {
  const DB = createD1();
  DB.raw.prepare(`INSERT INTO activities (id,title,starts_at,ends_at,opens_at,deadline_at,priority_quota,lottery_quota,status,created_by)
    VALUES ('A','t','2026-11-12T06:00:00.000Z','2026-11-12T08:00:00.000Z','2026-10-16T00:00:00.000Z','2026-11-06T04:00:00.000Z',1,3,'closed','x'),
           ('B','t','2026-11-12T06:00:00.000Z','2026-11-12T08:00:00.000Z','2026-10-16T00:00:00.000Z','2026-11-06T04:00:00.000Z',15,3,'closed','x')`).run();
  DB.raw.prepare(`INSERT INTO registrations (id,activity_id,class_code,teacher_name,teacher_email,status) VALUES ('r1','A','701','n','e','priority'),('r2','A','702','n','e','lottery_pool'),('r3','A','703','n','e','lottery_pool')`).run();
  assert.deepEqual((await drawLottery(DB, { email: ADMIN }, 'A', '2026-11-07T00:00:00.000Z')).selected.sort(), ['702', '703']);
  assert.equal((await drawLottery(DB, { email: ADMIN }, 'B', '2026-11-07T00:00:00.000Z')).pool_size, 0);
  assert.equal(DB.raw.prepare(`SELECT status FROM activities WHERE id='B'`).get().status, 'drawn');
});

test('admin cancel, registration list, CSV export with formula escaping', async () => {
  const { call, DB } = setup();
  const id = await openActivity(call);
  const r = await call('/api/registrations', { method: 'POST', body: reg(id, '701', { teacher_name: '=HYPERLINK("x")', notes: '含,逗號' }), as: teacher(1) });
  const rid = r.data.registration.id;
  const list = await call(`/api/admin/activities/${id}/registrations`, { as: ADMIN });
  assert.equal(list.data.registrations[0].teacher_email, teacher(1));
  const csv = await call(`/api/admin/activities/${id}/registrations.csv`, { as: ADMIN });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.data, /'=HYPERLINK\(""x""\)/);
  assert.match(csv.data, /"含,逗號"/);
  assert.equal((await call(`/api/admin/activities/${id}/registrations/${rid}/cancel`, { method: 'POST', body: { reason: '誤報' }, as: ADMIN })).status, 200);
  assert.equal((await call(`/api/admin/activities/${id}/registrations/${rid}/cancel`, { method: 'POST', body: {}, as: ADMIN })).status, 404);
  // 被取消的班級可以重新報名
  assert.equal((await call('/api/registrations', { method: 'POST', body: reg(id, '701'), as: teacher(2) })).status, 201);
  assert.equal((await call('/api/registrations', { method: 'POST', body: reg(id, '701'), as: teacher(3) })).status, 409);
  const actions = DB.raw.prepare('SELECT action FROM audit_logs ORDER BY id').all().map(x => x.action);
  assert.deepEqual(actions, ['activity_create', 'activity_status', 'register', 'registration_cancel', 'register']);
});

test('csv helper', () => {
  const out = toCsv([{ class_code: '701', teacher_name: '+cmd', teacher_email: 'a@b', accompany: 'no', status: 'priority', draw_rank: null, submitted_at: '2026-10-16T00:00:01.000Z', notes: 'a\nb' }]);
  assert.ok(out.startsWith('﻿順序,班級'));
  assert.match(out, /1,701,'\+cmd,a@b,否,優先錄取,,2026-10-16 08:00:01,"a\nb"/);
});

// ---------- 取消遞補、重新報名、修改名額 ----------
async function seeded(quota = 2, n = 4) {
  const DB = createD1();
  DB.raw.prepare(`INSERT INTO activities (id,title,starts_at,ends_at,opens_at,deadline_at,priority_quota,lottery_quota,status,created_by)
    VALUES ('A','t','2026-11-12T06:00:00.000Z','2026-11-12T08:00:00.000Z','2026-10-16T00:00:00.000Z','2026-11-06T04:00:00.000Z',?,1,'open','x')`).run(quota);
  for (let i = 1; i <= n; i++) {
    await register(DB, { email: teacher(i) }, { activityId: 'A', classCode: String(700 + i), teacherName: 'n', accompany: 'no', notes: '' }, `2026-10-20T00:00:0${i}.000Z`);
  }
  const status = () => Object.fromEntries(DB.raw.prepare(`SELECT class_code, status FROM registrations WHERE status != 'cancelled' ORDER BY submitted_at`).all().map(r => [r.class_code, r.status]));
  const idOf = c => DB.raw.prepare(`SELECT id FROM registrations WHERE class_code = ? AND status != 'cancelled'`).get(c).id;
  return { DB, status, idOf };
}
const admin = { email: ADMIN };
const editBody = over => ({ title: 't', speaker: '', venue: '', audience: '', description: '',
  starts_date: '2026-11-12', starts_time: '14:00', ends_date: '2026-11-12', ends_time: '16:00',
  opens_date: '2026-10-16', opens_time: '08:00', deadline_date: '2026-11-06', deadline_time: '12:00',
  priority_quota: 2, lottery_quota: 1, organizer_name: '教學組長', organizer_email: 'tjjh111@tjjh.tc.edu.tw', ...over });


test('cancel → earliest pool entry promoted; cancelled class may re-register at the end', async () => {
  const { DB, status, idOf } = await seeded(2, 4);
  assert.deepEqual(status(), { 701: 'priority', 702: 'priority', 703: 'lottery_pool', 704: 'lottery_pool' });
  await cancelRegistration(DB, admin, 'A', idOf('701'), '測試');
  assert.deepEqual(status(), { 702: 'priority', 703: 'priority', 704: 'lottery_pool' });
  const again = await register(DB, { email: teacher(1) }, { activityId: 'A', classCode: '701', teacherName: 'n', accompany: 'no', notes: '' }, '2026-10-21T00:00:00.000Z');
  assert.equal(again.status, 'lottery_pool');
  assert.deepEqual(status(), { 702: 'priority', 703: 'priority', 704: 'lottery_pool', 701: 'lottery_pool' });
  await assert.rejects(register(DB, { email: teacher(9) }, { activityId: 'A', classCode: '701', teacherName: 'n', accompany: 'no', notes: '' }, '2026-10-21T00:00:01.000Z'), /已經報名/);
  const log = JSON.parse(DB.raw.prepare(`SELECT details_json FROM audit_logs WHERE action='priority_recompute'`).get().details_json);
  assert.deepEqual(log, { reason: 'registration_cancel', changes: [{ class_code: '703', from: 'lottery_pool', to: 'priority' }] });
});

test('editing quota after opening recomputes by submission order', async () => {
  const { DB, status } = await seeded(2, 5);
  await updateActivity(DB, admin, 'A', validateActivity(editBody({ priority_quota: 4 })));
  assert.deepEqual(status(), { 701: 'priority', 702: 'priority', 703: 'priority', 704: 'priority', 705: 'lottery_pool' });
  await updateActivity(DB, admin, 'A', validateActivity(editBody({ priority_quota: 1, venue: '禮堂' })));
  assert.deepEqual(status(), { 701: 'priority', 702: 'lottery_pool', 703: 'lottery_pool', 704: 'lottery_pool', 705: 'lottery_pool' });
  // 只改文字不會產生狀態異動紀錄
  const before = DB.raw.prepare(`SELECT COUNT(*) n FROM audit_logs WHERE action='priority_recompute'`).get().n;
  await updateActivity(DB, admin, 'A', validateActivity(editBody({ priority_quota: 1, venue: '大禮堂' })));
  assert.equal(DB.raw.prepare(`SELECT COUNT(*) n FROM audit_logs WHERE action='priority_recompute'`).get().n, before);
  const upd = JSON.parse(DB.raw.prepare(`SELECT details_json FROM audit_logs WHERE action='activity_update' ORDER BY id DESC`).get().details_json);
  assert.equal(upd.before.venue, '禮堂');
  assert.equal(upd.after.venue, '大禮堂');
});

test('after the lottery, activity cannot be edited and cancel does not reshuffle', async () => {
  const { DB, status, idOf } = await seeded(2, 4);
  await drawLottery(DB, admin, 'A', '2026-11-07T00:00:00.000Z', new Uint8Array(32).fill(1));
  await assert.rejects(updateActivity(DB, admin, 'A', validateActivity(editBody({ priority_quota: 3 }))), /不可修改/);
  const before = status();
  await cancelRegistration(DB, admin, 'A', idOf('701'), 'x');
  const after = status();
  delete before['701'];
  assert.deepEqual(after, before);
});
