# 3C Notice Board
This project is part of the 3C Thread To Success™ ecosystem — a growing digital platform that combines creativity, structure, and real-world application.

The 3C Thread To Success™ brand, including its name, structure, characters (Aurion 3C Mascot), and overall system design, remains the intellectual property of the creator and is not included in this license.

Commercial use of the brand or replication of the ecosystem identity is not permitted without permission.

---

**A Cloudflare-powered slideshow notice board for the 3C Thread To Success™ community.**
Independent creator project — all rights reserved to Chef Anica (3C Thread To Success™). Built in collaboration with Claude (Anthropic) as engineering partner.

---

## What This App Does

3C Notice Board is a slideshow-style app with two faces:

- **Public Viewer** — a swipe/slide-through board of notice pages, newest page first, with a bottom bar to move between pages. No login required.
- **Admin Panel** — a login-gated control room where Chef Anica manages every page: upload new media, or link an existing Cloudflare/R2 URL to reuse an asset without re-uploading.

### Page format
- Each page is **portrait**, **landscape**, or **square**.
- Pages can hold an **image**, **video**, or **audio** file.
- Video/audio pages carry no on-player icons — playback is controlled by a single **Play** button below the media, matching the page's aspect (9:16, 16:9, or square).
- The most recently added page is always shown first, on both admin and public sides.

### Sharing
- Every content page (excluding the landing page) has:
  - A **Download** button (saves that page's media)
  - A **Share** button (copies that page's direct URL to clipboard)

### Branding
- 3C Thread To Success™ logo + favicon on both public and admin views
- Titles in neon light-purple, ~32px
- No emojis in the interface — symbols only for buttons and controls

---

## 🎨 Credits

*Designed and Built with ❤️ by Claude (Anthropic) × Chef Anica · 3C Thread To Success™ Cooking Lab*  🧪👨‍🍳

"Think Smarter, Not Harder - Zero Shortcuts"

---

## 👤 Creator

Anica-blip (“Chef”)
Founder of 3C Thread To Success™ ("Cooking Lab")
Independent Creator | Community Builder

---

🧠 Philosophy

“Think it. Do it. Own it.”

This project was built from vision, persistence, and a commitment to creating meaningful and structured experiences — even with minimal resources.

---

## Repo Structure

```
3c-notice-board/
├── admin/
│   ├── index.html        ← admin panel (login-gated)
│   ├── login.html         ← admin login page
│   ├── admin.js
│   └── admin.css
├── public/
│   ├── index.html         ← public viewer (no login)
│   ├── viewer.js
│   └── viewer.css
├── shared/
│   ├── assets/
│   │   ├── logo.png
│   │   └── favicon.png
│   └── styles/
│       └── variables.css
├── worker/
│   ├── worker.js
│   └── wrangler.toml
├── README.md
└── SETUP.md
```

See `SETUP.md` for Cloudflare Worker, R2, and Supabase configuration steps.
