export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(body, status = 200, extraHeaders) {
  const headers = new Headers(extraHeaders);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(JSON.stringify(body), { status, headers });
}

export async function readJson(request) {
  const text = await request.text();
  if (text.length > 16384) throw new HttpError(413, '資料過大');
  try {
    const body = JSON.parse(text);
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch (_) { /* fall through */ }
  throw new HttpError(400, '資料格式錯誤');
}

// 臺灣時間（UTC+8，無日光節約）日期 + 時間 → UTC ISO 字串（與 SQLite strftime('%Y-%m-%dT%H:%M:%fZ') 同格式，可直接字串比較）。
export function taipeiToUtcIso(date, time) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  const tm = /^(\d{2}):(\d{2})$/.exec(String(time || ''));
  if (!dm || !tm) return null;
  const [y, mo, d] = dm.slice(1).map(Number);
  const [h, mi] = tm.slice(1).map(Number);
  if (h > 23 || mi > 59) return null;
  const local = Date.UTC(y, mo - 1, d, h, mi);
  const back = new Date(local);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return new Date(local - 8 * 3600e3).toISOString();
}

export function nowIso() {
  return new Date().toISOString();
}
