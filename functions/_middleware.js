// Security headers for Function responses.
//
// public/_headers only covers static assets; anything rendered by a Function
// must set its own. The report documents agents attempting XSS and admin
// impersonation, so assume every request is probing.
//
// script-src 'none' means no injected markup can ever execute, even if an
// escaping bug slips through. There is no JavaScript on this site by design.

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-robots-tag': 'index, follow',
};

export async function onRequest(context) {
  const response = await context.next();
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
