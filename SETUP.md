# SETUP — 3C Notice Board

This documents the actual working setup, as deployed and confirmed — not a plan, the real steps.

---

## 1. Prerequisites

- GitHub repo: `Anica-blip/3c-notice-board`, Pages enabled (Settings → Pages → Build and deployment → **Deploy from a branch** → `main` / `/root`)
- Cloudflare account with the existing R2 bucket `3c-library-files`
- Node.js + `wrangler` CLI installed locally
- Existing GitHub OAuth App **"Anica-blip Tools"** (Client ID `Ov23liE08ErtOUs8SrV6`) — reused, not recreated

---

## 2. Repo structure

```
3c-notice-board/
├── index.html          ← admin panel (login-gated)
├── login.html            ← admin login (GitHub OAuth)
├── landing.html           ← Landing Cover tool (no separate login — relies on index.html's session)
├── js/
│   ├── auth.js            ← session handling, WORKER_BASE
│   ├── admin.js           ← builder logic (local-first, Save persists to Worker)
│   ├── landing.js          ← Landing Cover upload logic
│   └── icons.js            ← shared SVG icon set
├── css/
│   └── style.css           ← shared dark-purple theme
├── assets/
│   ├── 3C Thread To Success logo.png   ← add manually, not fabricated by Claude
│   └── favicon.png                      ← add manually
├── public/
│   ├── index.html          ← public viewer (no login, reads ?project=)
│   ├── viewer.js
│   └── viewer.css
├── worker/
│   └── index.js             ← Cloudflare Worker (OAuth + API)
└── wrangler.toml
```

---

## 3. Local deploy folder (separate from the GitHub repo)

The Worker is deployed from your own machine, not from GitHub — GitHub Pages and the Cloudflare Worker are two independent deployments that happen to share files.

```
~/3c-deploy/3c-notice-board/
├── wrangler.toml
└── worker/
    └── index.js
```

Keep this folder's `wrangler.toml` and `worker/index.js` identical to what's in the GitHub repo — copy over manually whenever either changes.

---

## 4. Deploying the Worker

From inside `~/3c-deploy/3c-notice-board/`:

```
wrangler login
```
One-time browser authorization. Skip if already done for another project.

```
wrangler deploy
```
Creates/publishes the Worker. Prints the live URL on success — currently:
```
https://3c-notice-board.3c-innertherapy.workers.dev
```

---

## 5. Secrets (set once, persist across redeploys)

```
wrangler secret put GITHUB_CLIENT_SECRET
```
Value: the Secret from the "Anica-blip Tools" GitHub OAuth App (`github.com/settings/developers` → OAuth Apps → generate/view Client secret).

```
wrangler secret put SESSION_SECRET
```
Value: any random string (e.g. from `openssl rand -hex 32` or randomkeygen.com). Not tied to any external service — just needs to be long and known only to this Worker.

**Status: both already set and confirmed working** — login has been tested successfully.

---

## 6. GitHub OAuth App callback

The OAuth App's Authorization callback URL must be:
```
https://3c-notice-board.3c-innertherapy.workers.dev/auth/callback
```
**Status: confirmed working** — login flow tested end-to-end.

---

## 7. Frontend → Worker connection

`js/auth.js` — `WORKER_BASE` must match the deployed Worker URL exactly:
```js
const WORKER_BASE = 'https://3c-notice-board.3c-innertherapy.workers.dev';
```
**Status: set.**

---

## 8. Data model (as actually implemented)

- **One JSON file per project** in the R2 bucket: `notice-board/{id}-{slug}.json`, containing `{ id, title, slug, pages, landing, created_at, updated_at }` together — not split across multiple files.
- **Index file**: `notice-board/projects.json` — lightweight summaries only (id, title, key, cloudflare_url, page_count) for the Archive list. Not a second copy of project data.
- **Media uploads**: `notice-board/media/{timestamp}-{filename}`, served publicly via `https://files.3c-public-library.org/{key}`.
- **Page IDs**: `page-001`, `page-002`, etc. — assigned once by the Worker at save time, stable across edits/reorders so share links never break.

---

## 9. What requires the Worker vs. what doesn't

| Action | Needs Worker? |
|---|---|
| Add/remove/reorder pages, change media type, edit fields | **No** — fully local until Save |
| Uploading a file for preview | Yes (has to land in R2 to get a URL) |
| Save (create or update a project) | Yes |
| Loading the Archive list | Yes |
| Viewing `index.html` at all | Yes — login-gated via `requireLogin()` |
| Viewing `landing.html` | No separate gate — relies on an existing session from `index.html` |
| Public viewer (`public/index.html`) | Yes, but read-only, no login required |

---

## 10. Day-to-day workflow

1. Log in via `index.html` → GitHub OAuth → redirected back with a session.
2. Type a title, click **+ Add** to build pages, upload files or paste R2 URLs.
3. Click **Save** (toolbar) — creates the project (or updates it if loaded via Archive → Edit), shows the Cloudflare URL.
4. Go to `landing.html`, pick the project from the dropdown, upload its cover.
5. Share the `cloudflare_url` from the Archive — that's the public viewer link (`public/index.html?project={id}`).

---

## 11. When to redeploy the Worker vs. just `git push`

- **Only `git push`** (no Wrangler needed): any change to `index.html`, `login.html`, `landing.html`, anything in `js/`, `css/`, or `public/`.
- **`wrangler deploy` required**: any change to `worker/index.js` or `wrangler.toml`.
