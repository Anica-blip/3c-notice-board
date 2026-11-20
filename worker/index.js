// worker/index.js — 3C Notice Board Worker
// 3C Thread To Success™
//
// ROUTE TABLE
//   PUBLIC — no sign-in, read only (the public viewer needs these)
//     GET    /share?project=<id>&page=<pageId>   social-preview page, then sends visitors to the viewer
//     GET    /api/projects/<id>                  project title + viewer address
//     GET    /api/projects/<id>/pages            the project's pages
//     GET    /api/projects/<id>/landing          the project's cover image
//   OWNER ONLY — Supabase GitHub sign-in, then rpc/is_owner must return true
//     GET    /api/projects                       list all projects
//     POST   /api/projects                       create a project
//     PUT    /api/projects/<id>                  save a project (title + pages together)
//     DELETE /api/projects/<id>                  delete a project
//     PUT    /api/projects/<id>/landing          set the project's cover image
//     POST   /api/upload                         upload one media file to R2
//   Anything else: 404 (unknown address) or 405 (wrong method).
//
// LOGIN
//   There is no login code in this Worker. The admin pages sign in with GitHub
//   through Supabase (project "Aurion 3C Mascot") and send the sign-in token as
//   "Authorization: Bearer <token>". The Worker asks Supabase's is_owner()
//   function whether that token belongs to the owner. Only "true" passes.
//   Signing in alone is never enough. If the check cannot be made, the Worker
//   refuses (fails closed). No secrets and no variables are needed here: the
//   Supabase address and the anon key below are public by design.
//
// STORAGE
//   No database. R2 bucket binding NOTICE_BUCKET (bucket 3c-library-files):
//     notice-board/projects.json        index of all projects
//     notice-board/{id}-{slug}.json     one file per project: { title, pages, landing }
//     notice-board/media/…              uploaded files
//
// DEPLOY
//   Wrangler only (never paste this code into the Cloudflare dashboard):
//     cd ~/3c-deploy/3c-notice-board
//     npx wrangler deploy

const SUPABASE_URL      = 'https://cgxjqsbrditbteqhdyus.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNneGpxc2JyZGl0YnRlcWhkeXVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTExMTY1ODEsImV4cCI6MjA2NjY5MjU4MX0.xUDy5ic-r52kmRtocdcW8Np9-lczjMZ6YKPXc03rIG4';

// Websites allowed to call the owner-only routes from a browser.
const ALLOWED_ORIGINS = ['https://anica-blip.github.io'];

const VIEWER_BASE = 'https://anica-blip.github.io/3c-notice-board/public/';
const R2_CDN      = 'https://files.3c-public-library.org/';
const INDEX_KEY   = 'notice-board/projects.json';

// Limits
const MAX_JSON_BYTES   = 1000000;            // project save / cover requests
const MAX_UPLOAD_BYTES = 90 * 1024 * 1024;   // one media file
const MAX_PAGES        = 500;
const MAX_TITLE_CHARS  = 200;
const MAX_KEY_CHARS    = 500;
const MAX_URL_CHARS    = 2000;
const MEDIA_TYPES      = ['image', 'video', 'audio'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const originAllowed = !!origin && ALLOWED_ORIGINS.includes(origin);

    // Browser pre-flight: only the allowed website gets an answer.
    if (request.method === 'OPTIONS') {
      if (!originAllowed) return new Response(null, { status: 403 });
      const res = new Response(null, { status: 204 });
      res.headers.set('Access-Control-Allow-Origin', origin);
      res.headers.append('Vary', 'Origin');
      res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.headers.set('Access-Control-Max-Age', '86400');
      return res;
    }

    let isPublic = true;
    let response;

    try {
      const url   = new URL(request.url);
      const route = matchRoute(url.pathname, request.method);
      isPublic = route.isPublic;

      if (!isPublic) {
        // A browser from any other website is refused before anything else.
        if (origin && !originAllowed) throw new HttpError(403, 'Origin not allowed');
        await requireOwner(request);
      }

      response = await route.run(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) {
        response = json({ error: err.message }, err.status);
      } else {
        console.error('notice-board error:', err && err.message ? err.message : err);
        response = json({ error: 'Server error' }, 500);
      }
    }

    return withCors(response, origin, originAllowed, isPublic);
  },
};

// ── Routing ──────────────────────────────────────────────────

function matchRoute(path, method) {
  const allow = (list) => {
    if (!list.includes(method)) throw new HttpError(405, 'Method not allowed');
  };

  if (path === '/share') {
    allow(['GET']);
    return { isPublic: true, run: (req, env, url) => serveOgPage(url, env) };
  }

  if (path === '/api/projects') {
    allow(['GET', 'POST']);
    return method === 'GET'
      ? { isPublic: false, run: (req, env) => listProjects(env) }
      : { isPublic: false, run: (req, env) => createProject(req, env) };
  }

  if (path === '/api/upload') {
    allow(['POST']);
    return { isPublic: false, run: (req, env) => uploadMedia(req, env) };
  }

  const m = path.match(/^\/api\/projects\/(\d{1,6})(\/pages|\/landing)?$/);
  if (m) {
    const id  = m[1];
    const sub = m[2] || '';

    if (sub === '') {
      allow(['GET', 'PUT', 'DELETE']);
      if (method === 'GET')    return { isPublic: true,  run: (req, env) => getProjectMeta(id, env) };
      if (method === 'PUT')    return { isPublic: false, run: (req, env) => saveProject(id, req, env) };
      return                          { isPublic: false, run: (req, env) => deleteProject(id, env) };
    }

    if (sub === '/pages') {
      allow(['GET']);
      return { isPublic: true, run: (req, env) => listPages(id, env) };
    }

    allow(['GET', 'PUT']);
    return method === 'GET'
      ? { isPublic: true,  run: (req, env) => getLanding(id, env) }
      : { isPublic: false, run: (req, env) => setLanding(id, req, env) };
  }

  throw new HttpError(404, 'Not found');
}

// ── Owner check (Supabase is_owner) ──────────────────────────

async function requireOwner(request) {
  const header = request.headers.get('Authorization') || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'Sign in required');

  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/is_owner`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new HttpError(503, 'Sign-in check unavailable');
  }

  if (res.status === 401 || res.status === 403) throw new HttpError(401, 'Sign in required');
  if (!res.ok) throw new HttpError(503, 'Sign-in check unavailable');

  let answer;
  try { answer = await res.json(); } catch { throw new HttpError(503, 'Sign-in check unavailable'); }

  if (answer !== true) throw new HttpError(403, 'Not allowed');
}

// ── Input handling ───────────────────────────────────────────

async function readJson(request) {
  const declared = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (declared > MAX_JSON_BYTES) throw new HttpError(413, 'Request too large');

  const text = await request.text();
  if (text.length > MAX_JSON_BYTES) throw new HttpError(413, 'Request too large');

  let value;
  try { value = JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Invalid JSON');
  }
  return value;
}

function cleanTitle(title) {
  if (title === undefined || title === null) return '';
  if (typeof title !== 'string') throw new HttpError(400, 'Invalid title');
  return title.trim().slice(0, MAX_TITLE_CHARS);
}

function cleanKey(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_KEY_CHARS || /[\u0000-\u001f]/.test(value)) {
    throw new HttpError(400, 'Invalid file key');
  }
  return value;
}

function cleanUrl(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_URL_CHARS || !/^https?:\/\//i.test(value)) {
    throw new HttpError(400, 'Invalid file address');
  }
  return value;
}

function cleanPages(pages) {
  if (pages === undefined || pages === null) return [];
  if (!Array.isArray(pages) || pages.length > MAX_PAGES) throw new HttpError(400, 'Invalid pages');

  return pages.map((p) => {
    if (p === null || typeof p !== 'object' || Array.isArray(p)) throw new HttpError(400, 'Invalid page');
    const media_type = p.media_type === undefined ? 'image' : p.media_type;
    if (!MEDIA_TYPES.includes(media_type)) throw new HttpError(400, 'Invalid media type');

    const page = {
      media_type,
      r2_key: cleanKey(p.r2_key),
      external_url: cleanUrl(p.external_url),
      shareable: !!p.shareable,
    };
    // A saved page keeps its stable id; new pages get the next number later.
    if (typeof p.id === 'string' && /^page-\d+$/.test(p.id)) page.id = p.id;
    return page;
  });
}

// ══════════════════ PROJECTS ══════════════════

async function readProjectsIndex(env) {
  const file = await env.NOTICE_BUCKET.get(INDEX_KEY);
  if (!file) return [];
  try { return await file.json(); } catch { return []; }
}

async function writeProjectsIndex(env, projects) {
  await env.NOTICE_BUCKET.put(INDEX_KEY, JSON.stringify(projects), {
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
  return json(await readProjectsIndex(env));
}

// Every project is exactly one JSON file: notice-board/{id}-{slug}.json
// containing { title, pages, landing } together. The top-level index
// (projects.json) only stores lightweight summaries for the Archive
// list — it is not a second copy of project data, just a directory.
function projectFileKey(id, slug) {
  return `notice-board/${id}-${slug}.json`;
}

async function createProject(request, env) {
  const body  = await readJson(request);
  const title = cleanTitle(body.title);
  const pages = cleanPages(body.pages);

  const projects = await readProjectsIndex(env);

  const id   = nextProjectId(projects);
  const slug = slugify(title);
  const key  = projectFileKey(id, slug);
  const finalPages = assignPageIds(pages);

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

  return json({ ...summary, pages: finalPages, landing: null }, 201);
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
  const body  = await readJson(request);
  const title = cleanTitle(body.title);
  const pages = cleanPages(body.pages);

  const projects = await readProjectsIndex(env);
  const idx = projects.findIndex(p => p.id === id);
  if (idx === -1) throw new HttpError(404, 'Project not found');

  const summary = projects[idx];
  const existing = await readProjectFile(summary.key, env);
  const finalPages = assignPageIds(pages);

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

  return json({ ...summary, pages: finalPages, landing: projectData.landing || null });
}

async function deleteProject(id, env) {
  const projects = await readProjectsIndex(env);
  const idx = projects.findIndex(p => p.id === id);
  if (idx === -1) throw new HttpError(404, 'Project not found');

  const [removed] = projects.splice(idx, 1);
  await writeProjectsIndex(env, projects);
  await env.NOTICE_BUCKET.delete(removed.key); // one file, one delete — no folder listing needed

  return new Response(null, { status: 204 });
}

async function getSummaryOrThrow(id, env) {
  const projects = await readProjectsIndex(env);
  const summary = projects.find(p => p.id === id);
  if (!summary) throw new HttpError(404, 'Project not found');
  return summary;
}

async function readProjectFile(key, env) {
  const file = await env.NOTICE_BUCKET.get(key);
  if (!file) return { pages: [], landing: null };
  try { return await file.json(); } catch { return { pages: [], landing: null }; }
}

// ══════════════════ PUBLIC READS ══════════════════

const OG_DESCRIPTION =
  'Welcome to the 3C Thread To Success where ideas become action. Discover ' +
  'practical insights and resources designed to inspire growth, lifelong ' +
  'learning, and meaningful progress.';

/**
 * Serves an HTML page with OG meta tags for social preview cards.
 * Bots/crawlers see the rich card; humans are instantly redirected
 * to the real viewer with the correct project + page in the URL.
 */
async function serveOgPage(url, env) {
  const rawProject = url.searchParams.get('project') || '';
  const rawPage    = url.searchParams.get('page') || '';
  const projectId  = /^\d{1,6}$/.test(rawProject) ? rawProject : '';
  const pageId     = /^page-\d{1,6}$/.test(rawPage) ? rawPage : '';

  const viewerUrl = `${VIEWER_BASE}?project=${encodeURIComponent(projectId)}${pageId ? `#page=${encodeURIComponent(pageId)}` : ''}`;

  let title    = '3C Notice Board';
  let imageUrl = '';

  try {
    const summary = await getSummaryOrThrow(projectId, env);
    title = summary.title || title;

    if (pageId) {
      const obj  = await env.NOTICE_BUCKET.get(summary.key);
      if (obj) {
        const data  = await obj.json();
        const found = (data.pages || []).find(p => String(p.id) === String(pageId));
        if (found) {
          imageUrl = found.external_url || (found.r2_key ? `${R2_CDN}${found.r2_key}` : '');
        }
      }
    }
  } catch { /* project not found — serve generic OG */ }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${escHtml(title)}</title>
  <meta property="og:type"        content="website" />
  <meta property="og:title"       content="${escHtml(title)}" />
  <meta property="og:description" content="${escHtml(OG_DESCRIPTION)}" />
  <meta property="og:url"         content="${escHtml(viewerUrl)}" />
  ${imageUrl ? `<meta property="og:image" content="${escHtml(imageUrl)}" />
  <meta property="og:image:width"  content="400" />
  <meta property="og:image:height" content="566" />` : ''}
  <meta name="twitter:card"        content="summary_large_image" />
  <meta name="twitter:title"       content="${escHtml(title)}" />
  <meta name="twitter:description" content="${escHtml(OG_DESCRIPTION)}" />
  ${imageUrl ? `<meta name="twitter:image" content="${escHtml(imageUrl)}" />` : ''}
  <meta http-equiv="refresh" content="0;url=${escHtml(viewerUrl)}" />
</head>
<body>
  <script>window.location.replace(${JSON.stringify(viewerUrl)});</script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function getProjectMeta(id, env) {
  const summary = await getSummaryOrThrow(id, env);
  return json({ id: summary.id, title: summary.title, cloudflare_url: summary.cloudflare_url });
}

async function listPages(id, env) {
  const summary = await getSummaryOrThrow(id, env);
  const data = await readProjectFile(summary.key, env);
  return json(data.pages || []);
}

async function getLanding(id, env) {
  const summary = await getSummaryOrThrow(id, env);
  const data = await readProjectFile(summary.key, env);
  return json(data.landing || null);
}

// ══════════════════ LANDING COVER (a field inside the project's single file) ══════════════════

async function setLanding(id, request, env) {
  const input = await readJson(request);
  const r2_key = cleanKey(input.r2_key);
  const external_url = cleanUrl(input.external_url);

  const summary = await getSummaryOrThrow(id, env);
  const data = await readProjectFile(summary.key, env);

  data.landing = {
    r2_key,
    external_url,
    updated_at: new Date().toISOString(),
  };
  data.updated_at = new Date().toISOString();

  await env.NOTICE_BUCKET.put(summary.key, JSON.stringify(data), {
    httpMetadata: { contentType: 'application/json' },
  });
  return json(data.landing);
}

// ══════════════════ UPLOAD (generic — used while building, before save) ══════════════════

async function uploadMedia(request, env) {
  const declared = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (declared > MAX_UPLOAD_BYTES) throw new HttpError(413, 'File too large');

  let form;
  try { form = await request.formData(); } catch { throw new HttpError(400, 'Invalid upload'); }

  const file = form.get('file');
  if (!file || typeof file === 'string') throw new HttpError(400, 'Missing file field');
  if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'File too large');

  // Images, video and audio only. A file the browser cannot identify arrives
  // as application/octet-stream (or empty) and is accepted, as before.
  const type = (file.type || '').toLowerCase();
  if (type && type !== 'application/octet-stream' && !/^(image|video|audio)\//.test(type)) {
    throw new HttpError(415, 'Only image, video and audio files can be uploaded');
  }

  const safeName = (file.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100);
  const key = `notice-board/media/${Date.now()}-${safeName}`;

  await env.NOTICE_BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: type || 'application/octet-stream' },
  });

  return json({ r2_key: key, url: `${R2_CDN}${key}` }, 201);
}

// ══════════════════ CORS / JSON ══════════════════

// Public reads are open to every website. Owner-only routes answer only the
// allowed website (and say so with Vary: Origin).
function withCors(response, origin, originAllowed, isPublic) {
  const res = new Response(response.body, response);
  if (isPublic) {
    res.headers.set('Access-Control-Allow-Origin', '*');
  } else if (originAllowed) {
    res.headers.set('Access-Control-Allow-Origin', origin);
    res.headers.append('Vary', 'Origin');
  }
  return res;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
