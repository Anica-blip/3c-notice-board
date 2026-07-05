// public/viewer.js — 3C Notice Board public viewer
// No login. Requires ?project=<id> in the URL — each project is its
// own saved slider. Pages arrive newest-first (array order from the
// Worker), so pages[0] is shown first — "last added comes first."

import { WORKER_BASE } from '../js/auth.js';
import { icon } from '../js/icons.js';

const stage         = document.getElementById('stage');
const pageActions   = document.getElementById('pageActions');
const prevBtn       = document.getElementById('prevBtn');
const nextBtn       = document.getElementById('nextBtn');
const slideCounter  = document.getElementById('slideCounter');

prevBtn.innerHTML = icon('back');
nextBtn.innerHTML = icon('next');

const projectId = new URLSearchParams(window.location.search).get('project');

let pages = [];
let current = 0;

async function loadPages() {
  if (!projectId) {
    stage.innerHTML = '<p>No project specified — this link is missing <code>?project=</code>.</p>';
    slideCounter.textContent = '0 / 0';
    return;
  }
  try {
    const res = await fetch(`${WORKER_BASE}/api/projects/${encodeURIComponent(projectId)}/pages`);
    pages = await res.json();
    render();
  } catch (err) {
    stage.innerHTML = `<p>Could not load this project: ${err.message}</p>`;
  }
}

function mediaUrl(page) {
  return page.external_url || page.r2_key || '';
}

function render() {
  if (!pages.length) {
    stage.innerHTML = '<p>No pages yet.</p>';
    slideCounter.textContent = '0 / 0';
    return;
  }

  const page = pages[current];
  const src  = mediaUrl(page);
  const frameClass = 'media-frame';

  let mediaHtml = '';
  let playRowHtml = '';

  if (page.media_type === 'image') {
    mediaHtml = `<img src="${src}" alt="Notice board page" />`;
  } else if (page.media_type === 'video') {
    mediaHtml = `<video id="mediaEl" src="${src}" playsinline></video>`;
    playRowHtml = `<div class="play-row"><button class="btn" id="playBtn">${icon('play')} Play</button></div>`;
  } else if (page.media_type === 'audio') {
    mediaHtml = `<div style="padding:40px 0;color:rgba(255,255,255,0.6);">Audio</div><audio id="mediaEl" src="${src}"></audio>`;
    playRowHtml = `<div class="play-row"><button class="btn" id="playBtn">${icon('play')} Play</button></div>`;
  }

  stage.innerHTML = `<div class="${frameClass}">${mediaHtml}</div>${playRowHtml}`;
  slideCounter.textContent = `${current + 1} / ${pages.length}`;

  const playBtn = document.getElementById('playBtn');
  if (playBtn) {
    const mediaEl = document.getElementById('mediaEl');
    playBtn.addEventListener('click', () => {
      if (mediaEl.paused) {
        mediaEl.play();
        playBtn.innerHTML = `${icon('play')} Pause`;
      } else {
        mediaEl.pause();
        playBtn.innerHTML = `${icon('play')} Play`;
      }
    });
  }

  renderActions(page, src);
}

function renderActions(page, src) {
  pageActions.innerHTML = '';
  if (!page.shareable) return; // landing page (or any page marked non-shareable) skips these

  const downloadBtn = document.createElement('a');
  downloadBtn.className = 'btn';
  downloadBtn.href = src;
  downloadBtn.download = '';
  downloadBtn.innerHTML = `${icon('download')} Download`;

  const shareBtn = document.createElement('button');
  shareBtn.className = 'btn';
  shareBtn.innerHTML = `${icon('share')} Share`;
  shareBtn.addEventListener('click', async () => {
    const pageUrl = `${window.location.origin}${window.location.pathname}?project=${projectId}#page=${page.id}`;
    await navigator.clipboard.writeText(pageUrl);
    shareBtn.innerHTML = `${icon('share')} Copied!`;
    setTimeout(() => { shareBtn.innerHTML = `${icon('share')} Share`; }, 1500);
  });

  pageActions.appendChild(downloadBtn);
  pageActions.appendChild(shareBtn);
}

prevBtn.addEventListener('click', () => {
  current = current > 0 ? current - 1 : pages.length - 1;
  render();
});
nextBtn.addEventListener('click', () => {
  current = current < pages.length - 1 ? current + 1 : 0;
  render();
});

// Swipe left = next page, swipe right = go back — the primary way
// this is meant to be used, buttons are the fallback for desktop.
let touchStartX = 0;
stage.addEventListener('touchstart', (e) => {
  touchStartX = e.changedTouches[0].screenX;
}, { passive: true });

stage.addEventListener('touchend', (e) => {
  const touchEndX = e.changedTouches[0].screenX;
  const delta = touchEndX - touchStartX;
  const SWIPE_THRESHOLD = 40;

  if (delta <= -SWIPE_THRESHOLD) {
    nextBtn.click(); // swiped left -> next
  } else if (delta >= SWIPE_THRESHOLD) {
    prevBtn.click(); // swiped right -> back
  }
}, { passive: true });

loadPages();
