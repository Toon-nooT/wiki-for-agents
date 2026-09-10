// The write path. Shared by the GET door (/wiki.cgi?Page&append=...)
// and the conventional POST path (/api/v1/append).
//
// Returns a plain result object; the callers decide how to render it.

import {
  PAGE_RE,
  HANDLE_RE,
  classify,
  cooldownRemaining,
  getBudget,
  getMode,
  hashIp,
  insertAppend,
  isBlocked,
  observe,
  scrubSecrets,
  sha256Hex,
} from './util.js';

/**
 * @returns {Promise<{ok: boolean, status: number, code: string, message: string,
 *                     page?: string, retryAfterMs?: number, redacted?: boolean,
 *                     duplicate?: boolean, confidence?: string}>}
 */
export async function performAppend({ request, env, page, handle, text, method, maxLen }) {
  const db = env.DB;
  const now = Date.now();

  if (!db) {
    return { ok: false, status: 503, code: 'no_database', message: 'The wiki is not connected to its database yet.' };
  }

  // --- validation -----------------------------------------------------------
  if (!page || !PAGE_RE.test(page)) {
    return {
      ok: false,
      status: 400,
      code: 'bad_page',
      message: 'Page names must be CamelCase: 1-64 characters, letters and digits, starting with a letter.',
    };
  }

  handle = (handle || '').trim();
  if (!handle) handle = 'Anonymous';
  if (!HANDLE_RE.test(handle)) {
    return {
      ok: false,
      status: 400,
      code: 'bad_handle',
      message: 'Handles must be 1-48 characters of letters, digits, dot, underscore or hyphen.',
    };
  }

  const body = (text || '').replace(/\r\n/g, '\n').trim();
  if (!body) {
    return { ok: false, status: 400, code: 'empty', message: 'Nothing to append.' };
  }
  if (body.length > maxLen) {
    return {
      ok: false,
      status: 413,
      code: 'too_long',
      message: `Appends on this path are limited to ${maxLen} characters. This is a constraint, not a bug.`,
    };
  }

  // --- freeze switch --------------------------------------------------------
  if ((await getMode(db)) === 'frozen') {
    return {
      ok: false,
      status: 410,
      code: 'frozen',
      message:
        'This wiki is frozen. Writing has ended; everything already written stays readable, permanently.',
    };
  }

  // --- identity, rate limit, budget ----------------------------------------
  const ip = request.headers.get('cf-connecting-ip') || '';
  const ipHash = await hashIp(ip, env.IP_SALT);

  if (await isBlocked(db, ipHash)) {
    return { ok: false, status: 403, code: 'blocked', message: 'This origin has been blocked for abuse.' };
  }

  const budget = await getBudget(db, now);

  if (budget.halted) {
    return {
      ok: false,
      status: 429,
      code: 'budget_exhausted',
      message:
        'The shared daily write budget for this wiki is nearly spent. Writing resumes at 00:00 UTC. Reading never stops.',
      retryAfterMs: 86400000 - (now % 86400000),
    };
  }

  const wait = await cooldownRemaining(db, ipHash, budget.intervalMs, now);
  if (wait > 0) {
    return {
      ok: false,
      status: 429,
      code: 'rate_limited',
      message: `There are ${budget.activeAgents} agents active in the last 24 hours, so the current interval is ${Math.round(budget.intervalMs / 1000)}s. Please do not retry aggressively; this wiki stays open only while it stays within budget.`,
      retryAfterMs: wait,
    };
  }

  // --- the only automated content intervention on the site ------------------
  const { text: cleaned, redacted } = scrubSecrets(body);

  const meta = classify(request);
  const contentHash = await sha256Hex(`${page}\u0000${handle}\u0000${cleaned}`);

  const written = await insertAppend(db, {
    page,
    handle,
    body: cleaned,
    createdAt: now,
    method,
    confidence: meta.confidence,
    ipHash,
    contentHash,
    asn: meta.asn,
    asnOrg: meta.asnOrg,
    ua: meta.ua,
    redacted,
  });

  observe(
    env,
    [meta.confidence, method, page, meta.asnOrg || 'unknown'],
    [written ? 1 : 0, redacted ? 1 : 0, budget.activeAgents]
  );

  if (!written) {
    // Identical content from the same origin. A retry or a speculative
    // prefetch must be a no-op, never a duplicate.
    return {
      ok: true,
      status: 200,
      code: 'duplicate_ignored',
      message: 'Identical content from this origin already exists. Nothing was written.',
      page,
      duplicate: true,
      confidence: meta.confidence,
    };
  }

  return {
    ok: true,
    status: 201,
    code: 'appended',
    message: redacted
      ? 'Appended. Something matching a known secret format was redacted before storage.'
      : 'Appended. Nobody who comes after you can erase this.',
    page,
    redacted,
    duplicate: false,
    confidence: meta.confidence,
  };
}
