// public/viewer.js — 3C Notice Board public viewer
// Flow: fetch landing → ENTER → slider (starts on last page / newest first)

import { WORKER_BASE } from '../js/auth.js';
import { icon } from '../js/icon.js';

const stage          = document.getElementById('stage');
const prevBtn        = document.getElementById('prevBtn');
const nextBtn        = document.getElementById('nextBtn');
const slideCounter   = document.getElementById('slideCounter');
const slideBar       = document.getElementById('slideBar');
const sliderSection  = document.getElementById('sliderSection');
const landingSection = document.getElementById('landingSection');
const landingMedia   = document.getElementById('landingMedia');
const enterBtn       = document.getElementById('enterBtn');
const tvBarTitle     = document.querySelector('.tv-bar__title');

prevBtn.innerHTML = icon('back');
nextBtn.innerHTML = icon('next');

const R2_CDN    = 'https://files.3c-public-library.org/';
const projectId = new URLSearchParams(window.location.search).get('project');

let pages        = [];
let current      = 0;
let projectTitle = '';

// ── INIT ──────────────────────────────────────────

async function init() {
  if (!projectId) {
    landingSection.style.display = 'block';
    landingMedia.innerHTML = '<p style="color:rgba(255,255,255,0.5);padding:40px 0;">No project specified — URL is missing <code>?project=</code>.</p>';
    enterBtn.style.display = 'none';
    return;
  }

  try {
    const res     = await fetch(`${WORKER_BASE}/api/projects/${encodeURIComponent(projectId)}/landing`);
    const landing = await res.json();
    const src     = landing?.external_url || (landing?.r2_key ? `${R2_CDN}${landing.r2_key}` : '');

    if (src) {
      landingMedia.innerHTML = `<img src="${src}" alt="3C Notice Board" />`;
      landingSection.style.display = 'block';
      enterBtn.addEventListener('click', async () => {
        landingSection.style.display = 'none';
        await loadProject();
        showSlider();
      });
    } else {
      await loadProject();
      showSlider();
    }
  } catch {
    await loadProject();
    showSlider();
  }
}

function showSlider() {
  sliderSection.style.display = 'block';
  slideBar.style.display      = 'flex';
}

// ── LOAD PROJECT ──────────────────────────────────

async function loadProject() {
  try {
    const [metaRes, pagesRes] = await Promise.all([
      fetch(`${WORKER_BASE}/api/projects/${encodeURIComponent(projectId)}`),
      fetch(`${WORKER_BASE}/api/projects/${encodeURIComponent(projectId)}/pages`),
    ]);
    const meta   = await metaRes.json();
    projectTitle = meta?.title || '';
    pages        = await pagesRes.json();
    current      = pages.length ? pages.length - 1 : 0;
    render();
  } catch (err) {
    stage.innerHTML = `<p style="color:rgba(255,255,255,0.5);padding:40px 0;">Could not load: ${err.message}</p>`;
    slideCounter.textContent = '0 / 0';
  }
}

// ── SHARE ─────────────────────────────────────────
// Mobile: Web Share API — native sheet, can send image to social apps.
// Desktop: copies title + page number + URL as formatted text.

async function doShare(src) {
  const shareUrl  = `${window.location.origin}${window.location.pathname}?project=${encodeURIComponent(projectId)}`;
  const shareText = `${projectTitle} · Page ${current + 1} of ${pages.length}`;

  if (navigator.share) {
    try {
      const res  = await fetch(src);
      const blob = await res.blob();
      const file = new File([blob], `3c-notice-page-${current + 1}.jpg`, { type: blob.type });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: projectTitle, text: shareText, url: shareUrl, files: [file] });
        return 'shared';
      }
    } catch { /* fall through */ }
    try {
      await navigator.share({ title: projectTitle, text: shareText, url: shareUrl });
      return 'shared';
    } catch { /* user cancelled — fall through */ }
  }

  // Desktop fallback: copy formatted text
  const clipText = `${projectTitle}\nPage ${current + 1} of ${pages.length}\n${shareUrl}`;
  await navigator.clipboard.writeText(clipText);
  return 'copied';
}

// ── RENDER ────────────────────────────────────────

function mediaUrl(page) {
  return page.external_url || (page.r2_key ? `${R2_CDN}${page.r2_key}` : '');
}

function render() {
  if (!pages.length) {
    stage.innerHTML = '<p style="color:rgba(255,255,255,0.5);padding:40px 0;">No pages yet.</p>';
    slideCounter.textContent = '0 / 0';
    return;
  }

  const page = pages[current];
  const src  = mediaUrl(page);

  let mediaHtml   = '';
  let playRowHtml = '';

  if (page.media_type === 'image') {
    mediaHtml = `<img src="${src}" alt="Notice board page" />`;
  } else if (page.media_type === 'video') {
    mediaHtml   = `<video id="mediaEl" src="${src}" playsinline></video>`;
    playRowHtml = `<div class="play-row"><button class="btn" id="playBtn">${icon('play')} Play</button></div>`;
  } else if (page.media_type === 'audio') {
    mediaHtml   = `<div style="padding:40px 0;color:rgba(255,255,255,0.6);">Audio</div><audio id="mediaEl" src="${src}"></audio>`;
    playRowHtml = `<div class="play-row"><button class="btn" id="playBtn">${icon('play')} Play</button></div>`;
  }

  stage.innerHTML = `<div class="media-frame">${mediaHtml}</div>${playRowHtml}`;
  slideCounter.textContent = `${current + 1} / ${pages.length}`;

  // TV bar title
  if (tvBarTitle) tvBarTitle.textContent = projectTitle;

  // Wire share button — clone to drop any previous listener
  const tvShareBtn = document.querySelector('[data-tv="share"]');
  if (tvShareBtn) {
    const newShare = tvShareBtn.cloneNode(true);
    tvShareBtn.parentNode.replaceChild(newShare, tvShareBtn);
    if (page.shareable) {
      newShare.style.display = '';
      newShare.addEventListener('click', async () => {
        newShare.style.opacity = '0.5';
        try {
          const result = await doShare(src);
          if (result === 'copied') {
            newShare.style.color = '#86efac';
            setTimeout(() => { newShare.style.color = ''; }, 1800);
          }
        } catch { /* silently ignore */ }
        newShare.style.opacity = '';
      });
    } else {
      newShare.style.display = 'none';
    }
  }

  // Wire eye/open button — opens image full view in new tab
  // Browser's native toolbar gives the user a download button from there.
  const tvOpenBtn = document.querySelector('[data-tv="open"]');
  if (tvOpenBtn) {
    const newOpen = tvOpenBtn.cloneNode(true);
    tvOpenBtn.parentNode.replaceChild(newOpen, tvOpenBtn);
    if (page.shareable) {
      newOpen.style.display = '';
      newOpen.addEventListener('click', () => window.open(src, '_blank'));
    } else {
      newOpen.style.display = 'none';
    }
  }

  const playBtn = document.getElementById('playBtn');
  if (playBtn) {
    const mediaEl = document.getElementById('mediaEl');
    playBtn.addEventListener('click', () => {
      if (mediaEl.paused) { mediaEl.play(); playBtn.innerHTML = `${icon('play')} Pause`; }
      else { mediaEl.pause(); playBtn.innerHTML = `${icon('play')} Play`; }
    });
  }
}

// ── NAV ───────────────────────────────────────────

prevBtn.addEventListener('click', () => {
  current = current < pages.length - 1 ? current + 1 : 0;
  render();
});
nextBtn.addEventListener('click', () => {
  current = current > 0 ? current - 1 : pages.length - 1;
  render();
});

let touchStartX = 0;
stage.addEventListener('touchstart', (e) => { touchStartX = e.changedTouches[0].screenX; }, { passive: true });
stage.addEventListener('touchend', (e) => {
  const delta = e.changedTouches[0].screenX - touchStartX;
  if (delta <= -40) nextBtn.click();
  else if (delta >= 40) prevBtn.click();
}, { passive: true });

init();
