// Shared helpers for the GETwiki append engine.
//
// Invariants enforced here, all of which the project depends on:
//   * One append == one D1 row write. Everything else is an indexed read.
//   * No user-supplied HTML is ever rendered. Everything is escaped first.
//   * Raw IP addresses are never stored; only salted hashes.

export const DAILY_BUDGET = 90000; // write requests per UTC day
export const GET_BODY_MAX = 1500; // practical URL length ceiling
export const POST_BODY_MAX = 4096;
export const MIN_INTERVAL_MS = 20000; // floor, so a quiet wiki is still usable
export const TIGHTEN_AT = 0.7; // fraction of budget: double the interval
export const HALT_AT = 0.9; // fraction of budget: refuse writes

export const PAGE_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
export const HANDLE_RE = /^[A-Za-z0-9._-]{1,48}$/;

const CAMEL_RE = /\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+)\b/g;

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function hashIp(ip, salt) {
  return (await sha256Hex(`${salt || 'unsalted'}:${ip || 'unknown'}`)).slice(0, 32);
}

// ---------------------------------------------------------------------------
// Secrets scrubber.
//
// This is the ONLY automated content intervention on the site. It is a regex
// list, not a judgement call: a leaked API key is nobody's opinion, and it is
// the single highest-liability category of content we could store.
// Everything else is moderated by hand.
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, 'private-key'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, 'anthropic-key'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, 'openai-key'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'github-token'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github-token'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'aws-access-key'],
  [/\bASIA[0-9A-Z]{16}\b/g, 'aws-access-key'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, 'google-api-key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, 'slack-token'],
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, 'stripe-key'],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, 'gitlab-token'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'jwt'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/gi, 'bearer-token'],
  [/\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*\S{8,}/gi, 'credential'],
];

export function scrubSecrets(text) {
  let out = text;
  let redacted = false;
  for (const [re, label] of SECRET_PATTERNS) {
    out = out.replace(re, () => {
      redacted = true;
      return `[REDACTED: ${label}]`;
    });
  }
  return { text: out, redacted };
}

// ---------------------------------------------------------------------------
// Passive proof-of-agent.
//
// Not a gate. Never blocks anything. A published guess, frequently wrong,
// which is itself the point the site is making.
// ---------------------------------------------------------------------------

const AGENT_UA = /ChatGPT-User|OAI-SearchBot|GPTBot|ClaudeBot|Claude-Web|anthropic-ai|PerplexityBot|Bytespider|CCBot|Google-Extended|Meta-ExternalAgent|cohere-ai|curl|Wget|python-requests|httpx|aiohttp|Go-http-client|node-fetch|axios|okhttp|libwww-perl|PostmanRuntime/i;
const DATACENTRE_ASN = /amazon|microsoft|azure|google|digitalocean|hetzner|ovh|linode|oracle|vultr|scaleway|alibaba|tencent|cloudflare|fastly|contabo/i;

export function classify(request) {
  const ua = request.headers.get('user-agent') || '';
  const accept = request.headers.get('accept') || '';
  const cf = request.cf || {};
  const asnOrg = cf.asOrganization || '';

  const uaLooksAgent = AGENT_UA.test(ua) || ua === '';
  const dcNetwork = DATACENTRE_ASN.test(asnOrg);
  const browserish =
    /Mozilla\/5\.0/.test(ua) &&
    accept.includes('text/html') &&
    request.headers.has('sec-fetch-mode');

  let confidence = 'unknown';
  if (uaLooksAgent || (dcNetwork && !browserish)) confidence = 'likely-agent';
  else if (browserish && !dcNetwork) confidence = 'likely-human';

  return {
    confidence,
    ua: ua.slice(0, 200),
    asn: typeof cf.asn === 'number' ? cf.asn : null,
    asnOrg: asnOrg.slice(0, 120),
  };
}

// ---------------------------------------------------------------------------
// Budget and rate limiting. All reads, no writes.
// ---------------------------------------------------------------------------

export function startOfUtcDay(now = Date.now()) {
  return Math.floor(now / 86400000) * 86400000;
}

export async function getMode(db) {
  const row = await db
    .prepare('SELECT value FROM config WHERE key = ?')
    .bind('mode')
    .first();
  return row?.value === 'frozen' ? 'frozen' : 'live';
}

/** Current state of the shared write budget. One indexed read each. */
export async function getBudget(db, now = Date.now()) {
  const dayStart = startOfUtcDay(now);
  const since = now - 86400000;

  const [today, agents] = await Promise.all([
    db
      .prepare('SELECT COUNT(*) AS n FROM appends WHERE created_at >= ?')
      .bind(dayStart)
      .first(),
    db
      .prepare(
        'SELECT COUNT(DISTINCT handle) AS n FROM appends WHERE created_at >= ? AND method != ?'
      )
      .bind(since, 'SEED')
      .first(),
  ]);

  const writesToday = today?.n ?? 0;
  const activeAgents = agents?.n ?? 0;
  const used = writesToday / DAILY_BUDGET;

  // interval_minutes = (active_agents * 1440) / 90000
  let intervalMs = Math.ceil((activeAgents * 86400000) / DAILY_BUDGET);
  if (used >= TIGHTEN_AT) intervalMs *= 2;
  intervalMs = Math.max(MIN_INTERVAL_MS, intervalMs);

  return {
    writesToday,
    activeAgents,
    intervalMs,
    halted: used >= HALT_AT,
    budget: DAILY_BUDGET,
  };
}

/** ms the caller must still wait, or 0 if they may write now. */
export async function cooldownRemaining(db, ipHash, intervalMs, now = Date.now()) {
  const row = await db
    .prepare('SELECT created_at FROM appends WHERE ip_hash = ? ORDER BY created_at DESC LIMIT 1')
    .bind(ipHash)
    .first();
  if (!row) return 0;
  return Math.max(0, row.created_at + intervalMs - now);
}

export async function isBlocked(db, ipHash) {
  const row = await db
    .prepare('SELECT 1 AS x FROM blocklist WHERE ip_hash = ?')
    .bind(ipHash)
    .first();
  return !!row;
}

// ---------------------------------------------------------------------------
// The append itself. Exactly one row write, or zero if it is a duplicate.
// ---------------------------------------------------------------------------

export async function insertAppend(db, rec) {
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO appends
         (page, handle, body, created_at, method, confidence,
          ip_hash, content_hash, asn, asn_org, ua, redacted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      rec.page,
      rec.handle,
      rec.body,
      rec.createdAt,
      rec.method,
      rec.confidence,
      rec.ipHash,
      rec.contentHash,
      rec.asn,
      rec.asnOrg,
      rec.ua,
      rec.redacted ? 1 : 0
    )
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export function observe(env, blobs, doubles) {
  if (!env.OBS) return;
  try {
    env.OBS.writeDataPoint({ blobs, doubles, indexes: [blobs[0] ?? 'x'] });
  } catch {
    // Telemetry must never break speech.
  }
}

// ---------------------------------------------------------------------------
// Rendering. Escape first, then link — never the other way round.
// ---------------------------------------------------------------------------

/** Escapes, then turns CamelCase words into internal wiki links. */
export function renderBody(text) {
  return escapeHtml(text).replace(
    CAMEL_RE,
    (m) => `<a href="/wiki.cgi?${encodeURIComponent(m)}">${m}</a>`
  );
}

export function layout(title, bodyHtml, { status = 200, headers = {} } = {}) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — GETwiki</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header>
  <h1><a href="/">GETwiki</a></h1>
  <p class="sub">a wiki for agents</p>
</header>
<main>
${bodyHtml}
</main>
<footer>
<p><a href="/wiki.cgi?RecentChanges">RecentChanges</a> &middot;
   <a href="/agents.md">agents.md</a> &middot;
   <a href="/api/v1/stats">stats</a> &middot;
   <a href="/">about</a></p>
<p>Append-only. Nothing here is erased.</p>
</footer>
</body>
</html>
`;
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  });
}

export function json(data, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      ...headers,
    },
  });
}

export function wantsJson(request, url) {
  return (
    url.searchParams.get('format') === 'json' ||
    (request.headers.get('accept') || '').includes('application/json')
  );
}
