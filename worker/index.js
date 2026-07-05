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

      // ── Projects ──
      if (path === '/api/projects' && request.method === 'GET')
        return corsResponse(env, await guarded(request, env, () => listProjects(env)));

      if (path === '/api/projects' && request.method === 'POST')
        return corsResponse(env, await guarded(request, env, () => createProject(request, env)));

      const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
      if (projectMatch) {
        const id = decodeURIComponent(projectMatch[1]);
        if (request.method === 'PUT')    return corsResponse(env, await guarded(request, env, () => renameProject(id, request, env)));
        if (request.method === 'DELETE') return corsResponse(env, await guarded(request, env, () => deleteProject(id, env)));
      }

      // ── Project-scoped pages ──
      const pagesMatch = path.match(/^\/api\/projects\/([^/]+)\/pages$/);
      if (pagesMatch) {
        const id = decodeURIComponent(pagesMatch[1]);
        if (request.method === 'GET')  return corsResponse(env, await listPages(id, env));
        if (request.method === 'POST') return corsResponse(env, await guarded(request, env, () => createPage(id, request, env)));
      }

      const reorderMatch = path.match(/^\/api\/projects\/([^/]+)\/pages\/reorder$/);
      if (reorderMatch && request.method === 'POST') {
        const id = decodeURIComponent(reorderMatch[1]);
        return corsResponse(env, await guarded(request, env, () => reorderPages(id, request, env)));
      }

      const pageMatch = path.match(/^\/api\/projects\/([^/]+)\/pages\/([^/]+)$/);
      if (pageMatch) {
        const id = decodeURIComponent(pageMatch[1]);
        const pageId = decodeURIComponent(pageMatch[2]);
        if (request.method === 'PUT')    return corsResponse(env, await guarded(request, env, () => updatePage(id, pageId, request, env)));
        if (request.method === 'DELETE') return corsResponse(env, await guarded(request, env, () => deletePage(id, pageId, env)));
      }

      // ── Project-scoped landing cover ──
      const landingMatch = path.match(/^\/api\/projects\/([^/]+)\/landing$/);
      if (landingMatch) {
        const id = decodeURIComponent(landingMatch[1]);
        if (request.method === 'GET') return corsResponse(env, await getLanding(id, env));
        if (request.method === 'PUT') return corsResponse(env, await guarded(request, env, () => setLanding(id, request, env)));
      }

      // ── Project-scoped upload ──
      const uploadMatch = path.match(/^\/api\/projects\/([^/]+)\/upload$/);
      if (uploadMatch && request.method === 'POST') {
        const id = decodeURIComponent(uploadMatch[1]);
        return corsResponse(env, await guarded(request, env, () => uploadMedia(id, request, env)));
      }

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
  const file = await env.NOTICE_BUCKET.get(env.PROJECTS_KEY);
  if (!file) return [];
  try { return await file.json(); } catch { return []; }
}

async function writeProjectsIndex(env, projects) {
  await env.NOTICE_BUCKET.put(env.PROJECTS_KEY, JSON.stringify(projects), {
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

async function createProject(request, env) {
  const { title } = await request.json();
  const projects = await readProjectsIndex(env);

  const id     = nextProjectId(projects);
  const slug   = slugify(title);
  const folder = `notice-board/${id}-${slug}/`;

  const project = {
    id,
    title: title || 'Untitled',
    slug,
    folder,
    cloudflare_url: `${env.PUBLIC_SITE_BASE}/public/?project=${id}`,
    page_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  projects.unshift(project);
  await writeProjectsIndex(env, projects);

  // Seed an empty pages manifest so listPages never has to guess
  await env.NOTICE_BUCKET.put(`${folder}manifest.json`, '[]', {
    httpMetadata: { contentType: 'application/json' },
  });

  return jsonResponse(project, 201);
}

async function renameProject(id, request, env) {
  const { title } = await request.json();
  const projects = await readProjectsIndex(env);
  const idx = projects.findIndex(p => p.id === id);
  if (idx === -1) return jsonResponse({ error: 'Project not found' }, 404);

  projects[idx].title = title || projects[idx].title;
  projects[idx].updated_at = new Date().toISOString();
  await writeProjectsIndex(env, projects);
  return jsonResponse(projects[idx]);
}

async function deleteProject(id, env) {
  const projects = await readProjectsIndex(env);
  const idx = projects.findIndex(p => p.id === id);
  if (idx === -1) return jsonResponse({ error: 'Project not found' }, 404);

  const [removed] = projects.splice(idx, 1);
  await writeProjectsIndex(env, projects);

  // Delete every object under this project's folder — manifest,
  // landing, and all uploaded media.
  const listing = await env.NOTICE_BUCKET.list({ prefix: removed.folder });
  await Promise.all(listing.objects.map(obj => env.NOTICE_BUCKET.delete(obj.key)));

  return new Response(null, { status: 204 });
}

async function getProjectOrThrow(id, env) {
  const projects = await readProjectsIndex(env);
  const project = projects.find(p => p.id === id);
  if (!project) throw new Error('Project not found');
  return project;
}

// ══════════════════ PAGES (scoped to a project) ══════════════════

async function readManifest(project, env) {
  const file = await env.NOTICE_BUCKET.get(`${project.folder}manifest.json`);
  if (!file) return [];
  try { return await file.json(); } catch { return []; }
}

async function writeManifest(project, env, pages) {
  await env.NOTICE_BUCKET.put(`${project.folder}manifest.json`, JSON.stringify(pages), {
    httpMetadata: { contentType: 'application/json' },
  });
  await syncPageCount(project.id, env, pages.length);
}

async function syncPageCount(id, env, count) {
  const projects = await readProjectsIndex(env);
  const idx = projects.findIndex(p => p.id === id);
  if (idx === -1) return;
  projects[idx].page_count = count;
  projects[idx].updated_at = new Date().toISOString();
  await writeProjectsIndex(env, projects);
}

async function listPages(id, env) {
  const project = await getProjectOrThrow(id, env);
  return jsonResponse(await readManifest(project, env));
}

async function createPage(id, request, env) {
  const project = await getProjectOrThrow(id, env);
  const input = await request.json();
  const pages = await readManifest(project, env);

  const page = {
    id: nextPageId(pages),
    page_type: input.page_type,
    media_type: input.media_type,
    r2_key: input.r2_key || null,
    external_url: input.external_url || null,
    shareable: input.shareable !== false,
    created_at: new Date().toISOString(),
  };

  pages.unshift(page); // newest at the front — top of grid, first slide
  await writeManifest(project, env, pages);
  return jsonResponse(page, 201);
}

function nextPageId(pages) {
  const max = pages.reduce((m, p) => {
    const match = /^page-(\d+)$/.exec(p.id || '');
    return match ? Math.max(m, parseInt(match[1], 10)) : m;
  }, 0);
  return `page-${String(max + 1).padStart(3, '0')}`;
}

async function updatePage(id, pageId, request, env) {
  const project = await getProjectOrThrow(id, env);
  const updates = await request.json();
  const pages = await readManifest(project, env);
  const idx = pages.findIndex(p => p.id === pageId);
  if (idx === -1) return jsonResponse({ error: 'Page not found' }, 404);

  pages[idx] = { ...pages[idx], ...updates, id: pageId };
  await writeManifest(project, env, pages);
  return jsonResponse(pages[idx]);
}

async function deletePage(id, pageId, env) {
  const project = await getProjectOrThrow(id, env);
  const pages = await readManifest(project, env);
  const idx = pages.findIndex(p => p.id === pageId);
  if (idx === -1) return jsonResponse({ error: 'Page not found' }, 404);

  const [removed] = pages.splice(idx, 1);
  await writeManifest(project, env, pages);

  if (removed.r2_key) await env.NOTICE_BUCKET.delete(removed.r2_key);
  return new Response(null, { status: 204 });
}

async function reorderPages(id, request, env) {
  const project = await getProjectOrThrow(id, env);
  const { order } = await request.json();
  if (!Array.isArray(order)) return jsonResponse({ error: 'Missing order array' }, 400);

  const pages = await readManifest(project, env);
  const byId = Object.fromEntries(pages.map(p => [p.id, p]));
  const reordered = order.map(pid => byId[pid]).filter(Boolean);
  pages.forEach(p => { if (!order.includes(p.id)) reordered.push(p); });

  await writeManifest(project, env, reordered);
  return jsonResponse(reordered);
}

// ══════════════════ LANDING COVER (scoped to a project) ══════════════════

async function getLanding(id, env) {
  const project = await getProjectOrThrow(id, env);
  const file = await env.NOTICE_BUCKET.get(`${project.folder}landing.json`);
  if (!file) return jsonResponse(null);
  try { return jsonResponse(await file.json()); } catch { return jsonResponse(null); }
}

async function setLanding(id, request, env) {
  const project = await getProjectOrThrow(id, env);
  const input = await request.json();
  const landing = {
    r2_key: input.r2_key || null,
    external_url: input.external_url || null,
    updated_at: new Date().toISOString(),
  };
  await env.NOTICE_BUCKET.put(`${project.folder}landing.json`, JSON.stringify(landing), {
    httpMetadata: { contentType: 'application/json' },
  });
  return jsonResponse(landing);
}

// ══════════════════ UPLOAD (scoped to a project) ══════════════════

async function uploadMedia(id, request, env) {
  const project = await getProjectOrThrow(id, env);
  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') return jsonResponse({ error: 'Missing file field' }, 400);

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `${project.folder}media/${Date.now()}-${safeName}`;

  await env.NOTICE_BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
  });

  return jsonResponse({ r2_key: key, url: `${env.PUBLIC_MEDIA_BASE}${key}` }, 201);
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
