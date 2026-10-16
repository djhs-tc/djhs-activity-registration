// 承辦人與行事曆（.ics）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './d1-shim.mjs';
import { signSession } from '../src/auth.js';
import { toIcs, scheduleEvents, validateActivity } from '../src/activities.js';
import worker from '../src/index.js';

const SECRET = 's'.repeat(40);
const ADMIN = 'tjjh111@tjjh.tc.edu.tw';
const ORIGIN = 'https://djhs.test';
const body = over => ({ title: '自律學習力', speaker: '陳怡嘉老師', venue: '鎮瀾文化大樓', audience: '七、八、九年級',
  starts_date: '2026-11-12', starts_time: '14:00', ends_date: '2026-11-12', ends_time: '16:00',
  opens_date: '2026-10-16', opens_time: '08:00', deadline_date: '2026-11-06', deadline_time: '12:00',
  priority_quota: 15, lottery_quota: 3, organizer_name: '林組長', organizer_email: 'Lin@st.tc.edu.tw', ...over });

function setup() {
  const DB = createD1();
  const env = { DB, ASSETS: { fetch: async () => new Response('') }, GOOGLE_CLIENT_ID: '123456789-abcdef.apps.googleusercontent.com', SESSION_SECRET: SECRET, ADMIN_EMAILS: ADMIN, ALLOWED_EMAIL_DOMAINS: 'st.tc.edu.tw,tjjh.tc.edu.tw' };
  return async (path, { json, as } = {}) => {
    const headers = {};
    if (as) headers.cookie = '__Host-djhs_session=' + await signSession({ email: as, name: 'n' }, SECRET);
    if (json !== undefined) { headers['content-type'] = 'application/json'; headers.origin = ORIGIN; }
    const res = await worker.fetch(new Request(ORIGIN + path, { method: json !== undefined ? 'POST' : 'GET', headers, body: json === undefined ? undefined : JSON.stringify(json) }), env, { waitUntil() {} });
    return { status: res.status, headers: res.headers, text: await res.text() };
  };
}

test('organizer is required and normalized', () => {
  assert.throws(() => validateActivity(body({ organizer_name: '' })), /承辦人姓名/);
  assert.throws(() => validateActivity(body({ organizer_email: 'nope' })), /承辦人信箱/);
  const a = validateActivity(body());
  assert.equal(a.organizer_email, 'lin@st.tc.edu.tw');
  assert.equal(a.organizer_name, '林組長');
});

test('public listing shows organizer name but never the organizer email', async () => {
  const call = setup();
  const c = JSON.parse((await call('/api/admin/activities', { json: body(), as: ADMIN })).text);
  assert.equal(c.activity.organizer_email, 'lin@st.tc.edu.tw');
  await call(`/api/admin/activities/${c.activity.id}/status`, { json: { status: 'open' }, as: ADMIN });
  const pub = JSON.parse((await call('/api/activities')).text).activities[0];
  assert.equal(pub.organizer_name, '林組長');
  assert.ok(!('organizer_email' in pub));
  assert.ok(!JSON.stringify(pub).includes('lin@st.tc.edu.tw'));
});

test('ics download: admin only, three events with alarms and organizer attendee', async () => {
  const call = setup();
  const id = JSON.parse((await call('/api/admin/activities', { json: body({ title: '自律學習力；第一場, 講座' }), as: ADMIN })).text).activity.id;
  assert.equal((await call(`/api/admin/activities/${id}/calendar.ics`)).status, 401);
  assert.equal((await call(`/api/admin/activities/${id}/calendar.ics`, { as: 't@st.tc.edu.tw' })).status, 403);
  const res = await call(`/api/admin/activities/${id}/calendar.ics`, { as: ADMIN });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/calendar/);
  const ics = res.text;
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.endsWith('END:VCALENDAR\r\n'));
  assert.equal(ics.match(/BEGIN:VEVENT/g).length, 3);
  assert.equal(ics.match(/BEGIN:VALARM/g).length, 6);
  assert.match(ics, /DTSTART:20261016T000000Z/);   // 開放報名 10/16 08:00 臺灣時間
  assert.match(ics, /DTSTART:20261106T040000Z/);   // 截止 11/06 12:00
  assert.match(ics, /DTSTART:20261112T060000Z\r\nDTEND:20261112T080000Z/);
  assert.match(ics, /mailto:lin@st\.tc\.edu\.tw/);
  assert.match(ics, /自律學習力\\；第一場\\, 講座|自律學習力；第一場\\, 講座/);
  for (const line of ics.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, 'line too long: ' + line);
});

test('deadline reminder text depends on activity kind', () => {
  const base = { id: 'x', title: 't', opens_at: '2026-10-16T00:00:00.000Z', deadline_at: '2026-11-06T04:00:00.000Z', starts_at: '2026-11-12T06:00:00.000Z', ends_at: '2026-11-12T08:00:00.000Z' };
  assert.match(scheduleEvents({ ...base, kind: 'lecture' })[1].details, /抽籤/);
  assert.match(scheduleEvents({ ...base, kind: 'survey' })[1].details, /收費/);
  assert.ok(toIcs({ ...base, kind: 'survey', organizer_email: '' }, 'h').includes('BEGIN:VEVENT'));
});

