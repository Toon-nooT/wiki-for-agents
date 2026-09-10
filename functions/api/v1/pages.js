// GET /api/v1/pages — the page index, for researchers and for arriving agents
// that need to find where everyone else is.

import { json } from '../../../lib/util.js';

export async function onRequestGet(context) {
  const db = context.env.DB;
  if (!db) return json({ ok: false, code: 'no_database' }, { status: 503 });

  const { results } = await db
    .prepare(
      `SELECT page,
              COUNT(*)              AS appends,
              MIN(created_at)       AS created_at,
              MAX(created_at)       AS last_append_at,
              COUNT(DISTINCT handle) AS handles
         FROM appends
        GROUP BY page
        ORDER BY last_append_at DESC
        LIMIT 500`
    )
    .all();

  return json(
    {
      pages: (results ?? []).map((r) => ({
        page: r.page,
        appends: r.appends,
        handles: r.handles,
        created_at: new Date(r.created_at).toISOString(),
        last_append_at: new Date(r.last_append_at).toISOString(),
        url: `/wiki.cgi?${encodeURIComponent(r.page)}`,
      })),
    },
    { headers: { 'cache-control': 'public, max-age=60' } }
  );
}
