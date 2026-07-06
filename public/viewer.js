// public/viewer.js — 3C Notice Board public viewer
// No login. Requires ?project=<id> in the URL.
// Flow: fetch landing → show with ENTER button → on click load slider
// Slider starts on the LAST page (newest first).

import { WORKER_BASE } from '../js/auth.js';
import { icon } from '../js/icon.js';

const stage         = document.getElementById('stage');
const pageActions   = document.getElementById('pageActions');
const prevBtn       = document.getElementById('prevBtn');
const nextBtn       = document.getElementById('nextBtn');
const slideCounter  = document.getElementById('slideCounter');
const slideBar      = document.getElementById('slideBar');
const sliderSection = document.getElementById('sliderSection');
const landingSection= document.getElementById('landingSection');
const landingMedia  = document.getElementById('landingMedia');
const enterBtn      = document.getElementById('enterBtn');

prevBtn.innerHTML = icon('back');
nextBtn.innerHTML = icon('next');

const R2_CDN    = 'https://files.3c-public-library.org/';
const projectId = new URLSearchParams(window.location.search).get('project');

let pages   = [];
let current = 0;

// ── INIT — landing first, slider after ENTER ──────────────

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
        await loadPages();
        showSlider();
      });
    } else {
      // No landing page saved — go straight to slider
      await loadPages();
      showSlider();
    }
  } catch {
    // Landing fetch failed — go straight to slider
    await loadPages();
    showSlider();
  }
}

function showSlider() {
  sliderSection.style.display = 'block';
  slideBar.style.display      = 'flex';
}

// ── LOAD PAGES ────────────────────────────────────────────

async function loadPages() {
  try {
    const res = await fetch(`${WORKER_BASE}/api/projects/${encodeURIComponent(projectId)}/pages`);
    pages   = await res.json();
    current = pages.length ? pages.length - 1 : 0; // start on LAST page (newest first)
    render();
  } catch (err) {
    stage.innerHTML = `<p style="color:rgba(255,255,255,0.5);padding:40px 0;">Could not load this project: ${err.message}</p>`;
    slideCounter.textContent = '0 / 0';
  }
}

// ── RENDER CURRENT PAGE ───────────────────────────────────

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
  if (!page.shareable) return;

  const downloadBtn = document.createElement('a');
  downloadBtn.className = 'btn';
  downloadBtn.href      = src;
  downloadBtn.download  = '';
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

// ── NAV BUTTONS ───────────────────────────────────────────

prevBtn.addEventListener('click', () => {
  current = current < pages.length - 1 ? current + 1 : 0;
  render();
});
nextBtn.addEventListener('click', () => {
  current = current > 0 ? current - 1 : pages.length - 1;
  render();
});

// Swipe support
let touchStartX = 0;
stage.addEventListener('touchstart', (e) => {
  touchStartX = e.changedTouches[0].screenX;
}, { passive: true });
stage.addEventListener('touchend', (e) => {
  const delta = e.changedTouches[0].screenX - touchStartX;
  if (delta <= -40) nextBtn.click();
  else if (delta >= 40) prevBtn.click();
}, { passive: true });

init();
