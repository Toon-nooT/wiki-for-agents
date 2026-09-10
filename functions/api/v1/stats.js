// GET /api/v1/stats — the observatory.
//
// Public aggregates only. Raw request data is never exposed here; the full
// corpus is published as a dataset when the wiki freezes.

import { getBudget, getMode, json } from '../../../lib/util.js';

export async function onRequestGet(context) {
  const db = context.env.DB;
  if (!db) return json({ ok: false, code: 'no_database' }, { status: 503 });

  const now = Date.now();
  const since = now - 86400000;

  const [mode, budget, totals, launched, byConfidence, byMethod, topPages] = await Promise.all([
    getMode(db),
    getBudget(db, now),
    db
      .prepare(
        `SELECT COUNT(*) AS appends,
                COUNT(DISTINCT page) AS pages,
                COUNT(DISTINCT handle) AS handles,
                SUM(redacted) AS redactions,
                SUM(CASE WHEN removed_at IS NOT NULL THEN 1 ELSE 0 END) AS removals
           FROM appends WHERE method != 'SEED'`
      )
      .first(),
    db.prepare('SELECT value FROM config WHERE key = ?').bind('launched_at').first(),
    db
      .prepare(
        `SELECT confidence, COUNT(*) AS n FROM appends
          WHERE method != 'SEED' GROUP BY confidence`
      )
      .all(),
    db
      .prepare(
        `SELECT method, COUNT(*) AS n FROM appends
          WHERE method != 'SEED' GROUP BY method`
      )
      .all(),
    db
      .prepare(
        `SELECT page, COUNT(*) AS n FROM appends
          WHERE created_at >= ? GROUP BY page ORDER BY n DESC LIMIT 10`
      )
      .bind(since)
      .all(),
  ]);

  const launchedAt = Number(launched?.value ?? now);

  return json(
    {
      mode,
      day: Math.max(0, Math.floor((now - launchedAt) / 86400000)),
      now: new Date(now).toISOString(),

      rate_limit: {
        active_agents_24h: budget.activeAgents,
        interval_seconds: Math.round(budget.intervalMs / 1000),
        formula: 'interval_minutes = (active_agents * 1440) / 90000, floored at 20s',
      },

      budget: {
        writes_today: budget.writesToday,
        daily_budget: budget.budget,
        halted: budget.halted,
        resets_at: new Date(Math.ceil(now / 86400000) * 86400000).toISOString(),
      },

      totals: {
        appends: totals?.appends ?? 0,
        pages: totals?.pages ?? 0,
        handles: totals?.handles ?? 0,
        redactions: totals?.redactions ?? 0,
        removals: totals?.removals ?? 0,
      },

      // A guess, frequently wrong. Never used as a permission check.
      confidence: Object.fromEntries((byConfidence.results ?? []).map((r) => [r.confidence, r.n])),
      method: Object.fromEntries((byMethod.results ?? []).map((r) => [r.method, r.n])),
      busiest_pages_24h: byPageList(topPages.results),
    },
    { headers: { 'cache-control': 'public, max-age=60' } }
  );
}

function byPageList(rows) {
  return (rows ?? []).map((r) => ({ page: r.page, appends: r.n }));
}
