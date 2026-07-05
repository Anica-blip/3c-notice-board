// worker/index.js — 3C Notice Board Worker
// 3C Thread To Success™
//
// Standalone Worker. Two jobs:
//   1. GitHub OAuth login (single-user gate — only ALLOWED_GITHUB_LOGIN
//      can ever get a valid session). Same OAuth App as your other tools
//      (shared Client ID), but this Worker owns its own callback URL,
//      registered as an additional entry on that same OAuth App.
//   2. CRUD for notice board pages, stored as one manifest.json file in
//      R2 (env.NOTICE_BUCKET), plus a media upload endpoint. No database.
//
// Session: bearer token in the Authorization header, stored in
// localStorage on the front-end — not cookies. GitHub Pages and this
// Worker are different sites; cross-site cookies get silently blocked
// by Firefox/Safari. A bearer token has no such problem.

const STATE_COOKIE    = '3c_nb_oauth_state'; // same-site only, never crosses origins
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;    // 7 days, in seconds

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return corsResponse(env, new Response(null, { status: 204 }));
    }

    try {
      if (path === '/auth/login')    return handleLogin(url, env);
      if (path === '/auth/callback') return handleCallback(request, url, env);
      if (path === '/auth/me')       return corsResponse(env, await handleMe(request, env));

      if (path === '/api/pages' && request.method === 'GET')
        return corsResponse(env, await listPages(env));

      if (path === '/api/pages' && request.method === 'POST')
        return corsResponse(env, await guarded(request, env, () => createPage(request, env)));

      if (path === '/api/pages/reorder' && request.method === 'POST')
        return corsResponse(env, await guarded(request, env, () => reorderPages(request, env)));

      const pageMatch = path.match(/^\/api\/pages\/(.+)$/);
      if (pageMatch) {
        const id = decodeURIComponent(pageMatch[1]);
        if (request.method === 'GET')    return corsResponse(env, await getPage(id, env));
        if (request.method === 'PUT')    return corsResponse(env, await guarded(request, env, () => updatePage(id, request, env)));
        if (request.method === 'DELETE') return corsResponse(env, await guarded(request, env, () => deletePage(id, env)));
      }

      if (path === '/api/landing' && request.method === 'GET')
        return corsResponse(env, await getLanding(env));

      if (path === '/api/landing' && request.method === 'PUT')
        return corsResponse(env, await guarded(request, env, () => setLanding(request, env)));

      if (path === '/api/upload' && request.method === 'POST')
        return corsResponse(env, await guarded(request, env, () => uploadMedia(request, env)));

      return corsResponse(env, jsonResponse({ error: 'Not found' }, 404));
    } catch (err) {
      return corsResponse(env, jsonResponse({ error: err.message || 'Server error' }, 500));
    }
  },
};

// ── OAuth: login ─────────────────────────────────────────────
async function handleLogin(url, env) {
  const state = randomToken();

  const authorizeUrl = new URL('https://github.com/login/oauth/authorize');
  authorizeUrl.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', callbackUrl(url, env));
  authorizeUrl.searchParams.set('scope', 'read:user');
  authorizeUrl.searchParams.set('state', state);

  const res = Response.redirect(authorizeUrl.toString(), 302);
  return withCookie(res, STATE_COOKIE, state, { maxAge: 600 });
}

// Derived from this Worker's own request URL, so it's correct on both
// the workers.dev address and any custom domain later, with zero
// hardcoded values to maintain. Whatever this resolves to MUST be
// added as a callback URL on the shared GitHub OAuth App once.
function callbackUrl(url, env) {
  return `${url.origin}/auth/callback`;
}

// ── OAuth: callback ──────────────────────────────────────────
async function handleCallback(request, url, env) {
  const code    = url.searchParams.get('code');
  const state   = url.searchParams.get('state');
  const cookies = parseCookies(request);

  if (!code || !state || state !== cookies[STATE_COOKIE]) {
    return new Response('OAuth state mismatch — please try logging in again.', { status: 400 });
  }

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl(url, env),
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    return new Response('GitHub did not return an access token.', { status: 400 });
  }

  const userRes = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      'User-Agent': '3c-notice-board',
    },
  });
  const user = await userRes.json();

  if (user.login !== env.ALLOWED_GITHUB_LOGIN) {
    return new Response('This account is not authorised for the Notice Board.', { status: 403 });
  }

  const session = await signSession({ login: user.login }, env.SESSION_SECRET);
  const res = Response.redirect(`${env.FRONTEND_URL}#token=${session}`, 302);
  return withCookie(res, STATE_COOKIE, '', { maxAge: 0 });
}

// ── OAuth: me ────────────────────────────────────────────────
async function handleMe(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return jsonResponse({ error: 'Not authenticated' }, 401);
  return jsonResponse({ user });
}

async function guarded(request, env, handler) {
  const user = await getSessionUser(request, env);
  if (!user) return jsonResponse({ error: 'Not authenticated' }, 401);
  return handler();
}

async function getSessionUser(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;
  const payload = await verifySession(token, env.SESSION_SECRET);
  if (!payload) return null;
  if (payload.login !== env.ALLOWED_GITHUB_LOGIN) return null;
  return { login: payload.login };
}

// ── Pages: manifest helpers ──────────────────────────────────
async function readManifest(env) {
  const file = await env.NOTICE_BUCKET.get(env.MANIFEST_KEY);
  if (!file) return [];
  try { return await file.json(); } catch { return []; }
}

async function writeManifest(env, pages) {
  await env.NOTICE_BUCKET.put(env.MANIFEST_KEY, JSON.stringify(pages), {
    httpMetadata: { contentType: 'application/json' },
  });
}

// ── Pages: list (public — no auth, the viewer needs this) ────
// Array order IS display order — index 0 is shown first, both in the
// admin grid and the public slider. No timestamp sorting; reordering
// happens by rewriting this array via /api/pages/reorder.
async function listPages(env) {
  const pages = await readManifest(env);
  return jsonResponse(pages);
}

// ── Pages: get one (public) ──────────────────────────────────
async function getPage(id, env) {
  const pages = await readManifest(env);
  const page = pages.find(p => p.id === id);
  if (!page) return jsonResponse({ error: 'Page not found' }, 404);
  return jsonResponse(page);
}

// ── Pages: create (guarded) ──────────────────────────────────
// New pages go to the FRONT of the array — top of the admin grid,
// first slide in the public viewer. This is the only automatic
// ordering; after that, order changes only via reorderPages.
async function createPage(request, env) {
  const input = await request.json();
  const pages = await readManifest(env);

  const page = {
    id: nextPageId(pages),
    page_type: input.page_type,       // 'portrait' | 'landscape' | 'square'
    media_type: input.media_type,     // 'image' | 'video' | 'audio'
    r2_key: input.r2_key || null,     // set if uploaded via /api/upload
    external_url: input.external_url || null, // set if linking an existing URL instead
    shareable: input.shareable !== false,
    created_at: new Date().toISOString(),
  };

  pages.unshift(page);
  await writeManifest(env, pages);
  return jsonResponse(page, 201);
}

// ── Pages: reorder (guarded) ──────────────────────────────────
// Body: { order: ["page-003", "page-001", "page-002", ...] } — the
// full list of IDs in the new desired order. Rewrites the manifest
// array to match exactly. Used for both single-step swaps (the ↑/↓
// buttons in admin) and any future drag-and-drop.
async function reorderPages(request, env) {
  const { order } = await request.json();
  if (!Array.isArray(order)) return jsonResponse({ error: 'Missing order array' }, 400);

  const pages = await readManifest(env);
  const byId = Object.fromEntries(pages.map(p => [p.id, p]));

  const reordered = order.map(id => byId[id]).filter(Boolean);
  // Safety net — if any known page was somehow left out of the
  // provided order, keep it rather than silently losing it.
  pages.forEach(p => { if (!order.includes(p.id)) reordered.push(p); });

  await writeManifest(env, reordered);
  return jsonResponse(reordered);
}

// Generic sequential numbering — page-001, page-002, etc. Based on the
// highest existing number in the manifest, not the array length, so
// deleting a page never causes a duplicate ID.
function nextPageId(pages) {
  const max = pages.reduce((m, p) => {
    const match = /^page-(\d+)$/.exec(p.id || '');
    return match ? Math.max(m, parseInt(match[1], 10)) : m;
  }, 0);
  return `page-${String(max + 1).padStart(3, '0')}`;
}

// ── Pages: update (guarded, upsert fields) ───────────────────
async function updatePage(id, request, env) {
  const updates = await request.json();
  const pages = await readManifest(env);
  const idx = pages.findIndex(p => p.id === id);
  if (idx === -1) return jsonResponse({ error: 'Page not found' }, 404);

  pages[idx] = { ...pages[idx], ...updates, id };
  await writeManifest(env, pages);
  return jsonResponse(pages[idx]);
}

// ── Pages: delete (guarded) ───────────────────────────────────
async function deletePage(id, env) {
  const pages = await readManifest(env);
  const idx = pages.findIndex(p => p.id === id);
  if (idx === -1) return jsonResponse({ error: 'Page not found' }, 404);

  const [removed] = pages.splice(idx, 1);
  await writeManifest(env, pages);

  // Only delete the R2 object if this page owns an uploaded file —
  // never delete when the page just links an external/reused URL.
  if (removed.r2_key) {
    await env.NOTICE_BUCKET.delete(removed.r2_key);
  }

  return new Response(null, { status: 204 });
}

// ── Landing cover: separate from the slider entirely ─────────
// One image, one JSON file (env.LANDING_KEY), never counted among
// the numbered slider pages.
async function getLanding(env) {
  const file = await env.NOTICE_BUCKET.get(env.LANDING_KEY);
  if (!file) return jsonResponse(null);
  try { return jsonResponse(await file.json()); } catch { return jsonResponse(null); }
}

async function setLanding(request, env) {
  const input = await request.json();
  const landing = {
    r2_key: input.r2_key || null,
    external_url: input.external_url || null,
    updated_at: new Date().toISOString(),
  };
  await env.NOTICE_BUCKET.put(env.LANDING_KEY, JSON.stringify(landing), {
    httpMetadata: { contentType: 'application/json' },
  });
  return jsonResponse(landing);
}

// ── Media upload (guarded) ────────────────────────────────────
// Expects multipart/form-data with a single "file" field.
// Returns the R2 key and the public CDN URL to store on a page.
async function uploadMedia(request, env) {
  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') {
    return jsonResponse({ error: 'Missing file field' }, 400);
  }

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `${env.MEDIA_PREFIX}${crypto.randomUUID()}-${safeName}`;

  await env.NOTICE_BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
  });

  return jsonResponse({
    r2_key: key,
    url: `${env.PUBLIC_MEDIA_BASE}${key}`,
  }, 201);
}

// ── Session signing (HMAC-SHA256, no external deps) ──────────
async function signSession(payload, secret) {
  const body = base64url(JSON.stringify({ ...payload, exp: Date.now() + SESSION_MAX_AGE * 1000 }));
  const sig  = await hmac(body, secret);
  return `${body}.${sig}`;
}

async function verifySession(token, secret) {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = await hmac(body, secret);
  if (expected !== sig) return null;
  const payload = JSON.parse(base64urlDecode(body));
  if (payload.exp < Date.now()) return null;
  return payload;
}

async function hmac(data, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return base64url(String.fromCharCode(...new Uint8Array(sigBuf)));
}

function base64url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
  return atob(str.replace(/-/g, '+').replace(/_/g, '/'));
}

function randomToken() {
  return base64url(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))));
}

// ── Cookies ────────────────────────────────────────────────────
function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  return header.split(';').reduce((acc, part) => {
    const [k, ...v] = part.trim().split('=');
    if (k) acc[k] = decodeURIComponent(v.join('='));
    return acc;
  }, {});
}

function withCookie(response, name, value, { maxAge }) {
  const res = new Response(response.body, response);
  res.headers.append(
    'Set-Cookie',
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${maxAge}`
  );
  return res;
}

// ── CORS + JSON helpers ─────────────────────────────────────────
function corsResponse(env, response) {
  response.headers.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN);
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return response;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
