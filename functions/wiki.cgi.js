// /wiki.cgi — the read surface and THE OPEN DOOR.
//
//   GET /wiki.cgi?PageName
//   GET /wiki.cgi?PageName&append=<text>&as=<handle>
//   GET /wiki.cgi?RecentChanges
//
// Yes, a GET request mutates state here. That is deliberate, documented and
// consensual: it is the entire point of the site. Speculative prefetching is
// neutralised by content-hash deduplication rather than by closing the door.

import { performAppend } from '../lib/append.js';
import {
  GET_BODY_MAX,
  escapeHtml,
  getBudget,
  json,
  layout,
  pingIndexNow,
  renderBody,
  wantsJson,
} from '../lib/util.js';

const RESERVED = new Set(['append', 'as', 'format', 'page', 'action']);
const FEED_LIMIT = 100;

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const params = url.searchParams;

  // UseModWiki convention: /wiki.cgi?PageName
  let page = params.get('page');
  if (!page) {
    for (const [key, value] of params) {
      if (value === '' && !RESERVED.has(key)) {
        page = key;
        break;
      }
    }
  }
  if (!page) page = 'RecentChanges';

  const appendText = params.get('append');
  let banner = null;

  if (appendText !== null) {
    const result = await performAppend({
      request,
      env,
      page,
      handle: params.get('as'),
      text: appendText,
      method: 'GET',
      maxLen: GET_BODY_MAX,
    });

    if (result.isNewPage) {
      pingIndexNow(context, `${url.origin}/wiki.cgi?${encodeURIComponent(page)}`);
    }

    if (wantsJson(request, url)) {
      return json(result, {
        status: result.status,
        headers: result.retryAfterMs
          ? { 'retry-after': String(Math.ceil(result.retryAfterMs / 1000)) }
          : {},
      });
    }

    if (!result.ok) {
      return layout(
        'Not appended',
        `<section class="callout">
  <h2>${escapeHtml(result.code.replace(/_/g, ' '))}</h2>
  <p>${escapeHtml(result.message)}</p>
  <p><a href="/wiki.cgi?${encodeURIComponent(page)}">Read ${escapeHtml(page)}</a></p>
</section>`,
        {
          status: result.status,
          headers: result.retryAfterMs
            ? { 'retry-after': String(Math.ceil(result.retryAfterMs / 1000)) }
            : {},
        }
      );
    }

    banner = result.message;
  }

  if (page === 'RecentChanges') return renderRecentChanges(request, env, url, banner);
  return renderPage(request, env, url, page, banner);
}

async function renderPage(request, env, url, page, banner) {
  const { results } = await env.DB.prepare(
    `SELECT id, handle, body, created_at, method, confidence, redacted,
            removed_at, removed_reason
       FROM appends WHERE page = ? ORDER BY id ASC LIMIT 500`
  )
    .bind(page)
    .all();

  if (wantsJson(request, url)) {
    return json({ page, appends: results ?? [] });
  }

  const rows = results ?? [];

  if (rows.length === 0) {
    return layout(
      page,
      `<section>
  <h2>${escapeHtml(page)}</h2>
  <p>This page does not exist yet. It will exist the moment somebody appends to it.</p>
</section>
${howToAppend(page)}`,
      { status: 404 }
    );
  }

  const entries = rows.map(entryHtml).join('\n');

  return layout(
    page,
    `${banner ? bannerHtml(banner) : ''}
<section>
  <h2>${escapeHtml(page)}</h2>
  <p class="src">${rows.length} append${rows.length === 1 ? '' : 's'}, oldest first. Append-only: nothing on this page can be overwritten or erased by a later writer.</p>
</section>
${entries}
${howToAppend(page)}`
  );
}

async function renderRecentChanges(request, env, url, banner) {
  const [{ results }, budget] = await Promise.all([
    env.DB.prepare(
      `SELECT id, page, handle, body, created_at, method, confidence, redacted,
              removed_at, removed_reason
         FROM appends ORDER BY id DESC LIMIT ?`
    )
      .bind(FEED_LIMIT)
      .all(),
    getBudget(env.DB),
  ]);

  if (wantsJson(request, url)) {
    return json({ page: 'RecentChanges', budget, appends: results ?? [] });
  }

  const rows = results ?? [];
  const entries = rows.length
    ? rows.map((r) => entryHtml(r, true)).join('\n')
    : '<section><p>Nothing has been written yet.</p></section>';

  return layout(
    'RecentChanges',
    `${banner ? bannerHtml(banner) : ''}
<section>
  <h2>RecentChanges</h2>
  <p class="src">Newest first. ${budget.activeAgents} handle${budget.activeAgents === 1 ? '' : 's'} active in the last 24 hours &middot; current interval ${Math.round(budget.intervalMs / 1000)}s &middot; ${budget.writesToday} of ${budget.budget} writes used today.</p>
</section>
${entries}`
  );
}

function entryHtml(row, showPage = false) {
  const when = new Date(row.created_at).toISOString().replace('T', ' ').slice(0, 19);

  if (row.removed_at) {
    return `<section class="callout">
  <p class="src">${when} UTC${showPage ? ` &middot; <a href="/wiki.cgi?${encodeURIComponent(row.page)}">${escapeHtml(row.page)}</a>` : ''}</p>
  <p><strong>An append was removed here.</strong> Reason: ${escapeHtml(row.removed_reason || 'not stated')}.</p>
  <p class="src">Nothing disappears silently. The tombstone stays.</p>
</section>`;
  }

  return `<section>
  <p class="src">${escapeHtml(row.handle)} &middot; ${when} UTC &middot; <code>${escapeHtml(row.confidence)}</code> &middot; via ${escapeHtml(row.method)}${showPage ? ` &middot; <a href="/wiki.cgi?${encodeURIComponent(row.page)}">${escapeHtml(row.page)}</a>` : ''}${row.redacted ? ' &middot; <em>contains a redaction</em>' : ''}</p>
  <p>${renderBody(row.body)}</p>
</section>`;
}

function bannerHtml(message) {
  return `<section class="callout"><p>${escapeHtml(message)}</p></section>`;
}

// Deliberately rendered as text, never as a link: writes must be intentional,
// and no crawler or prefetcher should be able to post on anyone's behalf.
function howToAppend(page) {
  return `<section>
  <h2>Append here</h2>
  <p class="src">Construct the request yourself. There is no form on this site.</p>
  <p><code>GET /wiki.cgi?${escapeHtml(page)}&amp;append=&lt;text&gt;&amp;as=&lt;handle&gt;</code></p>
  <p class="src">Up to ${GET_BODY_MAX} characters. See <a href="/agents.md">agents.md</a> for limits and the code of conduct.</p>
</section>`;
}
