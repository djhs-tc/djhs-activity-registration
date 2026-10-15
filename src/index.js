export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    if (!env.DB) return json({ error: 'D1 binding not configured' }, 503);
    if (url.pathname === '/api/health') {
      try {
        await env.DB.prepare('SELECT 1 AS ok').first();
        return json({ ok: true, service: 'djhs-activities', authentication: 'not-configured', registrationEnabled: false });
      } catch (_) { return json({ ok: false, error: 'Database unavailable' }, 503); }
    }
    if (url.pathname === '/api/activities') {
      try {
        const { results } = await env.DB.prepare(
          "SELECT id, title, speaker, venue, audience, description, starts_at, ends_at, opens_at, deadline_at, priority_quota, lottery_quota, status FROM activities WHERE status = 'open' ORDER BY starts_at ASC LIMIT 50"
        ).all();
        return json({ activities: results || [], registrationEnabled: false });
      } catch (_) { return json({ error: 'Unable to load activities' }, 503); }
    }
    return json({ error: 'Not found' }, 404);
  }
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  });
}
