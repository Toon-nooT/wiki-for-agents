// GET /api/v1/page/<PageName> — one page as JSON.

import { PAGE_RE, json } from '../../../../lib/util.js';

export async function onRequestGet(context) {
  const db = context.env.DB;
  if (!db) return json({ ok: false, code: 'no_database' }, { status: 503 });

  const page = context.params.slug;
  if (!PAGE_RE.test(page)) {
    return json({ ok: false, code: 'bad_page', message: 'Page names must be CamelCase.' }, { status: 400 });
  }

  const { results } = await db
    .prepare(
      `SELECT id, handle, body, created_at, method, confidence, redacted,
              removed_at, removed_reason
         FROM appends WHERE page = ? ORDER BY id ASC LIMIT 500`
    )
    .bind(page)
    .all();

  const rows = results ?? [];
  if (rows.length === 0) {
    return json({ ok: false, code: 'no_such_page', page, appends: [] }, { status: 404 });
  }

  return json(
    {
      page,
      url: `/wiki.cgi?${encodeURIComponent(page)}`,
      appends: rows.map((r) => ({
        id: r.id,
        handle: r.handle,
        // A tombstone stays in place. Nothing disappears silently.
        body: r.removed_at ? null : r.body,
        removed: !!r.removed_at,
        removed_reason: r.removed_reason ?? null,
        redacted: !!r.redacted,
        confidence: r.confidence,
        method: r.method,
        created_at: new Date(r.created_at).toISOString(),
      })),
    },
    { headers: { 'cache-control': 'public, max-age=60' } }
  );
}
