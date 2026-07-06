// worker/index.js — 3C Notice Board Worker
// 3C Thread To Success™
//
// Three jobs:
//   1. GitHub OAuth login (single-user gate — only ALLOWED_GITHUB_LOGIN
//      can ever get a valid session). Standalone OAuth setup, own
//      callback URL registered on the shared "Anica-blip Tools" App.
//   2. Projects — each saved project is its own folder in R2
//      (env.NOTICE_BUCKET), containing:
//        {folder}manifest.json  — the project's slider pages, array order
//                                  IS display order (index 0 = first slide)
//        {folder}landing.json   — that project's single cover image
//        {folder}media/…        — uploaded files for that project
//      A top-level projects.json indexes all projects for the admin
//      archive and the Landing tool's dropdown.
//   3. No database anywhere — R2 + JSON files only.
//
// Session: bearer token in the Authorization header (localStorage on
// the front-end), not cookies — GitHub Pages and this Worker are
// different origins, and cross-site cookies get silently blocked by
// Firefox/Safari.

const STATE_COOKIE    = '3c_nb_oauth_state';
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return corsResponse(env, new Response(null, { status: 204 }));
    }

    try {
      // ── Auth ──
      if (path === '/auth/login')    return handleLogin(url, env);
      if (path === '/auth/callback') return handleCallback(request, url, env);
      if (path === '/auth/me')       return corsResponse(env, await handleMe(request, env));

      // ── Projects — whole-document save: title + pages together ──
      if (path === '/api/projects' && request.method === 'GET')
        return corsResponse(env, await guarded(request, env, () => listProjects(env)));

      if (path === '/api/projects' && request.method === 'POST')
        return corsResponse(env, await guarded(request, env, () => createProject(request, env)));

      const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
      if (projectMatch) {
        const id = decodeURIComponent(projectMatch[1]);
        if (request.method === 'PUT')    return corsResponse(env, await guarded(request, env, () => saveProject(id, request, env)));
        if (request.method === 'DELETE') return corsResponse(env, await guarded(request, env, () => deleteProject(id, env)));
      }

      // Pages are read-only via the API — the public viewer and the
      // admin's "Edit" load both just need the current snapshot.
      // Pages are only ever WRITTEN as part of a whole project save
      // (POST/PUT above), never one at a time.
      const pagesMatch = path.match(/^\/api\/projects\/([^/]+)\/pages$/);
      if (pagesMatch && request.method === 'GET') {
        const id = decodeURIComponent(pagesMatch[1]);
        return corsResponse(env, await listPages(id, env));
      }

      // ── Project-scoped landing cover ──
      const landingMatch = path.match(/^\/api\/projects\/([^/]+)\/landing$/);
      if (landingMatch) {
        const id = decodeURIComponent(landingMatch[1]);
        if (request.method === 'GET') return corsResponse(env, await getLanding(id, env));
        if (request.method === 'PUT') return corsResponse(env, await guarded(request, env, () => setLanding(id, request, env)));
      }

      // ── Upload — generic, not project-scoped. Needed before a
      // project even exists yet, since title+cards are built up in
      // the browser first and only saved together at the end. ──
      // /api/upload removed — pages save as JSON only, no binary files.


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
    headers: { Authorization: `Bearer ${tokenData.access_token}`, 'User-Agent': '3c-notice-board' },
  });
  const user = await userRes.json();

  if (user.login !== env.ALLOWED_GITHUB_LOGIN) {
    return new Response('This account is not authorised for the Notice Board.', { status: 403 });
  }

  const session = await signSession({ login: user.login }, env.SESSION_SECRET);
  const res = Response.redirect(`${env.FRONTEND_URL}#token=${session}`, 302);
  return withCookie(res, STATE_COOKIE, '', { maxAge: 0 });
}

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

// ══════════════════ PROJECTS ══════════════════

async function readProjectsIndex(env) {
  const file = await env.NOTICE_BUCKET.get('notice-board/projects.json');
  if (!file) return [];
  try { return await file.json(); } catch { return []; }
}

async function writeProjectsIndex(env, projects) {
  await env.NOTICE_BUCKET.put('notice-board/projects.json', JSON.stringify(projects), {
    httpMetadata: { contentType: 'application/json' },
  });
}

function nextProjectId(projects) {
  const max = projects.reduce((m, p) => Math.max(m, parseInt(p.id, 10) || 0), 0);
  return String(max + 1).padStart(2, '0');
}

function slugify(title) {
  return (title || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'untitled';
}

async function listProjects(env) {
  return jsonResponse(await readProjectsIndex(env));
}

// Every project is exactly one JSON file: notice-board/{id}-{slug}.json
// containing { title, pages, landing } together. The top-level index
// (projects.json) only stores lightweight summaries for the Archive
// list — it is not a second copy of project data, just a directory.
function projectFileKey(id, slug) {
  return `notice-board/${id}-${slug}.json`;
}

async function createProject(request, env) {
  const { title, pages } = await request.json();
  const projects = await readProjectsIndex(env);

  const id   = nextProjectId(projects);
  const slug = slugify(title);
  const key  = projectFileKey(id, slug);
  const finalPages = assignPageIds(pages || []);

  const projectData = {
    id,
    title: title || 'Untitled',
    slug,
    pages: finalPages,
    landing: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  await env.NOTICE_BUCKET.put(key, JSON.stringify(projectData), {
    httpMetadata: { contentType: 'application/json' },
  });

  const summary = {
    id,
    title: projectData.title,
    slug,
    key,
    cloudflare_url: `https://anica-blip.github.io/3c-notice-board/public/?project=${id}`,
    page_count: finalPages.length,
    created_at: projectData.created_at,
    updated_at: projectData.updated_at,
  };
  projects.unshift(summary);
  await writeProjectsIndex(env, projects);

  return jsonResponse({ ...summary, pages: finalPages, landing: null }, 201);
}

// Assigns page-XXX ids only to entries that don't already have one —
// pages loaded from an existing project keep their stable id (so
// share links survive a reorder or edit), new ones get the next
// number in sequence.
function assignPageIds(pages) {
  let max = pages.reduce((m, p) => {
    const match = /^page-(\d+)$/.exec(p.id || '');
    return match ? Math.max(m, parseInt(match[1], 10)) : m;
  }, 0);

  return pages.map(p => {
    if (/^page-\d+$/.test(p.id || '')) return p;
    max++;
    return { ...p, id: `page-${String(max).padStart(3, '0')}` };
  });
}

async function saveProject(id, request, env) {
  const { title, pages } = await request.json();
  const projects = await readProjectsIndex(env);
  const idx = projects.findIndex(p => p.id === id);
  if (idx === -1) return jsonResponse({ error: 'Project not found' }, 404);

  const summary = projects[idx];
  const existing = await readProjectFile(summary.key, env);
  const finalPages = assignPageIds(pages || []);

  const projectData = {
    ...existing,
    title: title || summary.title,
    pages: finalPages,
    updated_at: new Date().toISOString(),
  };

  await env.NOTICE_BUCKET.put(summary.key, JSON.stringify(projectData), {
    httpMetadata: { contentType: 'application/json' },
  });

  summary.title      = projectData.title;
  summary.page_count = finalPages.length;
  summary.updated_at = projectData.updated_at;
  await writeProjectsIndex(env, projects);

  return jsonResponse({ ...summary, pages: finalPages, landing: projectData.landing || null });
}

async function deleteProject(id, env) {
  const projects = await readProjectsIndex(env);
  const idx = projects.findIndex(p => p.id === id);
  if (idx === -1) return jsonResponse({ error: 'Project not found' }, 404);

  const [removed] = projects.splice(idx, 1);
  await writeProjectsIndex(env, projects);
  await env.NOTICE_BUCKET.delete(removed.key); // one file, one delete — no folder listing needed

  return new Response(null, { status: 204 });
}

async function getSummaryOrThrow(id, env) {
  const projects = await readProjectsIndex(env);
  const summary = projects.find(p => p.id === id);
  if (!summary) throw new Error('Project not found');
  return summary;
}

async function readProjectFile(key, env) {
  const file = await env.NOTICE_BUCKET.get(key);
  if (!file) return { pages: [], landing: null };
  try { return await file.json(); } catch { return { pages: [], landing: null }; }
}

// ══════════════════ PAGES (read from the project's single file) ══════════════════

async function listPages(id, env) {
  const summary = await getSummaryOrThrow(id, env);
  const data = await readProjectFile(summary.key, env);
  return jsonResponse(data.pages || []);
}

// ══════════════════ LANDING COVER (a field inside the project's single file) ══════════════════

async function getLanding(id, env) {
  const summary = await getSummaryOrThrow(id, env);
  const data = await readProjectFile(summary.key, env);
  return jsonResponse(data.landing || null);
}

async function setLanding(id, request, env) {
  const summary = await getSummaryOrThrow(id, env);
  const data = await readProjectFile(summary.key, env);
  const input = await request.json();

  data.landing = {
    r2_key: input.r2_key || null,
    external_url: input.external_url || null,
    updated_at: new Date().toISOString(),
  };
  data.updated_at = new Date().toISOString();

  await env.NOTICE_BUCKET.put(summary.key, JSON.stringify(data), {
    httpMetadata: { contentType: 'application/json' },
  });
  return jsonResponse(data.landing);
}

// ══════════════════ UPLOAD (generic — used while building, before save) ══════════════════

async function uploadMedia(env, request) {
  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') return jsonResponse({ error: 'Missing file field' }, 400);

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `notice-board/media/${Date.now()}-${safeName}`;

  await env.NOTICE_BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
  });

  return jsonResponse({ r2_key: key, url: `https://files.3c-public-library.org/${key}` }, 201);
}

// ══════════════════ Session signing (HMAC-SHA256) ══════════════════

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

// ══════════════════ Cookies / CORS / JSON ══════════════════

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
  res.headers.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${maxAge}`);
  return res;
}

function corsResponse(env, response) {
  response.headers.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN);
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return response;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
