// js/admin.js — 3C Notice Board admin panel logic (two-panel builder)

import { requireLogin, authFetch, publicFetch, logout } from './auth.js';
import { icon } from './icons.js';

requireLogin();
document.getElementById('logoutBtn').addEventListener('click', logout);

function publicPageUrl(id) {
  return `${window.location.origin}/3c-notice-board/public/#page=${id}`;
}

/* ══════════════════ LANDING COVER ══════════════════ */

const landingFileInput = document.getElementById('landingFileInput');
const landingUrlInput  = document.getElementById('landingUrlInput');
const landingSaveBtn   = document.getElementById('landingSaveBtn');
const landingStatus    = document.getElementById('landingStatus');
const landingPreview   = document.getElementById('landingPreview');

async function loadLanding() {
  const res = await publicFetch('/api/landing');
  const landing = await res.json();
  if (landing && (landing.external_url || landing.r2_key)) {
    const src = landing.external_url || landing.r2_key;
    landingPreview.innerHTML = `<img src="${src}" alt="Landing cover" />`;
    landingUrlInput.value = landing.external_url || '';
  } else {
    landingPreview.textContent = 'No cover set';
  }
}

landingSaveBtn.addEventListener('click', async () => {
  landingStatus.textContent = '';
  const file = landingFileInput.files[0];
  const url  = landingUrlInput.value.trim();

  if (!file && !url) {
    landingStatus.textContent = 'Upload an image or paste a URL first.';
    return;
  }

  try {
    let body = {};
    if (file) {
      landingStatus.textContent = 'Uploading…';
      const formData = new FormData();
      formData.append('file', file);
      const uploadRes = await authFetch('/api/upload', { method: 'POST', body: formData });
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) throw new Error(uploadData.error || 'Upload failed');
      body = { r2_key: uploadData.r2_key, external_url: null };
    } else {
      body = { external_url: url, r2_key: null };
    }

    landingStatus.textContent = 'Saving…';
    const res = await authFetch('/api/landing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Save failed');

    landingStatus.textContent = 'Landing cover saved.';
    landingFileInput.value = '';
    loadLanding();
  } catch (err) {
    landingStatus.textContent = err.message;
  }
});

/* ══════════════════ SLIDER BUILDER (two panel) ══════════════════ */

let pages = [];
let selectedIndex = -1;

const cardPreviewLarge = document.getElementById('cardPreviewLarge');
const navCounter  = document.getElementById('navCounter');
const navPrev     = document.getElementById('navPrev');
const navNext     = document.getElementById('navNext');
const cardGrid    = document.getElementById('card-grid');
const cardCount   = document.getElementById('cardCount');
const addPageBtn  = document.getElementById('addPageBtn');
const pageForm    = document.getElementById('pageForm');
const formStatus  = document.getElementById('formStatus');
const submitBtn   = document.getElementById('submitBtn');
const copyUrlBtn  = document.getElementById('copyUrlBtn');
const openUrlBtn  = document.getElementById('openUrlBtn');

const pageTypeInput  = document.getElementById('pageType');
const mediaTypeInput = document.getElementById('mediaType');
const fileInput      = document.getElementById('fileInput');
const urlInput       = document.getElementById('urlInput');
const shareableInput = document.getElementById('shareableInput');

async function loadPages() {
  const res = await publicFetch('/api/pages');
  pages = await res.json();

  if (pages.length === 0) {
    selectedIndex = -1;
  } else if (selectedIndex === -1 || selectedIndex >= pages.length) {
    selectedIndex = 0;
  }

  renderGrid();
  renderSelected();
}

function selectedPage() {
  return selectedIndex >= 0 ? pages[selectedIndex] : null;
}

function mediaSrc(page) {
  return page.external_url || page.r2_key || '';
}

/* ── Large preview + form population ── */
function renderSelected() {
  const page = selectedPage();

  if (!page) {
    cardPreviewLarge.className = 'card-preview-large shape-portrait';
    cardPreviewLarge.innerHTML = '<div class="card-preview-empty">No pages yet<br/>Click + Add</div>';
    navCounter.textContent = '0 of 0';
    pageForm.style.opacity = '0.4';
    pageForm.style.pointerEvents = 'none';
    return;
  }

  pageForm.style.opacity = '1';
  pageForm.style.pointerEvents = 'auto';

  const src = mediaSrc(page);
  cardPreviewLarge.className = `card-preview-large shape-${page.page_type}`;

  let mediaHtml = `<div class="media-type-badge">${page.media_type}</div>`;
  if (page.media_type === 'image') {
    mediaHtml += src ? `<img src="${src}" alt="${page.id}" />` : '<div class="card-preview-empty">No image set</div>';
  } else if (page.media_type === 'video') {
    mediaHtml += src ? `<video src="${src}" muted></video>` : '<div class="card-preview-empty">No video set</div>';
  } else {
    mediaHtml += '<div class="card-preview-empty">Audio page<br/>' + (src ? src : 'No audio set') + '</div>';
  }
  cardPreviewLarge.innerHTML = mediaHtml;

  navCounter.textContent = `${selectedIndex + 1} of ${pages.length}`;

  pageTypeInput.value  = page.page_type;
  mediaTypeInput.value = page.media_type;
  urlInput.value       = page.external_url || '';
  shareableInput.checked = !!page.shareable;
  fileInput.value = '';
  submitBtn.textContent = `Save ${page.id}`;
}

/* ── Thumbnail grid ── */
function renderGrid() {
  cardCount.textContent = `${pages.length} page${pages.length === 1 ? '' : 's'}`;

  if (pages.length === 0) {
    cardGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;font-size:13px;color:var(--text-muted);">No pages added yet. Click + Add to start.</div>';
    return;
  }

  cardGrid.innerHTML = '';
  pages.forEach((page, i) => {
    const src = mediaSrc(page);
    const cell = document.createElement('div');
    cell.className = `grid-card${i === selectedIndex ? ' selected' : ''}`;

    let thumbHtml;
    if (page.media_type === 'image' && src) {
      thumbHtml = `<img class="grid-card-thumb shape-${page.page_type}" src="${src}" alt="${page.id}" />`;
    } else {
      const glyph = page.media_type === 'video' ? icon('play') : page.media_type === 'audio' ? icon('link') : icon('edit');
      thumbHtml = `<div class="grid-card-icon">${glyph}</div>`;
    }

    cell.innerHTML = `
      <span class="card-number">${i + 1}</span>
      <div class="card-reorder">
        <button class="reorder-btn" data-action="up" data-id="${page.id}" ${i === 0 ? 'disabled' : ''}>▲</button>
        <button class="reorder-btn" data-action="down" data-id="${page.id}" ${i === pages.length - 1 ? 'disabled' : ''}>▼</button>
      </div>
      <button class="card-remove" data-action="remove" data-id="${page.id}">×</button>
      ${thumbHtml}
      <div class="grid-card-label">${page.page_type} · ${page.media_type}</div>
    `;

    cell.addEventListener('click', (e) => {
      if (e.target.closest('[data-action]')) return;
      selectedIndex = i;
      renderGrid();
      renderSelected();
    });

    cardGrid.appendChild(cell);
  });

  cardGrid.querySelectorAll('[data-action="up"]').forEach(btn => {
    btn.addEventListener('click', () => moveCard(btn.dataset.id, -1));
  });
  cardGrid.querySelectorAll('[data-action="down"]').forEach(btn => {
    btn.addEventListener('click', () => moveCard(btn.dataset.id, 1));
  });
  cardGrid.querySelectorAll('[data-action="remove"]').forEach(btn => {
    btn.addEventListener('click', () => removeCard(btn.dataset.id));
  });
}

/* ── Reorder (swap with neighbour, persist via /api/pages/reorder) ── */
async function moveCard(id, direction) {
  const idx = pages.findIndex(p => p.id === id);
  const swapWith = idx + direction;
  if (swapWith < 0 || swapWith >= pages.length) return;

  const newOrder = [...pages];
  [newOrder[idx], newOrder[swapWith]] = [newOrder[swapWith], newOrder[idx]];

  const selectedId = selectedPage()?.id;
  await authFetch('/api/pages/reorder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order: newOrder.map(p => p.id) }),
  });

  await loadPages();
  if (selectedId) {
    const newIdx = pages.findIndex(p => p.id === selectedId);
    if (newIdx !== -1) { selectedIndex = newIdx; renderGrid(); renderSelected(); }
  }
}

async function removeCard(id) {
  if (!confirm(`Delete ${id}? This cannot be undone.`)) return;
  await authFetch(`/api/pages/${encodeURIComponent(id)}`, { method: 'DELETE' });
  selectedIndex = -1;
  loadPages();
}

/* ── Add ── */
addPageBtn.addEventListener('click', async () => {
  const res = await authFetch('/api/pages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page_type: 'portrait', media_type: 'image', shareable: true }),
  });
  const created = await res.json();
  await loadPages();
  selectedIndex = pages.findIndex(p => p.id === created.id);
  renderGrid();
  renderSelected();
});

/* ── Nav arrows ── */
navPrev.addEventListener('click', () => {
  if (selectedIndex > 0) { selectedIndex--; renderGrid(); renderSelected(); }
});
navNext.addEventListener('click', () => {
  if (selectedIndex < pages.length - 1) { selectedIndex++; renderGrid(); renderSelected(); }
});

/* ── Copy / Open ── */
copyUrlBtn.addEventListener('click', async () => {
  const page = selectedPage();
  if (!page) return;
  await navigator.clipboard.writeText(publicPageUrl(page.id));
  formStatus.textContent = 'URL copied.';
});
openUrlBtn.addEventListener('click', () => {
  const page = selectedPage();
  if (!page) return;
  window.open(publicPageUrl(page.id), '_blank', 'noopener');
});

/* ── Save (always updates the currently selected page) ── */
pageForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const page = selectedPage();
  if (!page) return;
  formStatus.textContent = '';

  const file        = fileInput.files[0];
  const externalUrl = urlInput.value.trim();

  try {
    const body = {
      page_type: pageTypeInput.value,
      media_type: mediaTypeInput.value,
      shareable: shareableInput.checked,
    };

    if (file) {
      formStatus.textContent = 'Uploading…';
      const formData = new FormData();
      formData.append('file', file);
      const uploadRes = await authFetch('/api/upload', { method: 'POST', body: formData });
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) throw new Error(uploadData.error || 'Upload failed');
      body.r2_key = uploadData.r2_key;
      body.external_url = null;
    } else if (externalUrl && externalUrl !== (page.external_url || '')) {
      body.external_url = externalUrl;
      body.r2_key = null;
    }

    formStatus.textContent = 'Saving…';
    const res = await authFetch(`/api/pages/${encodeURIComponent(page.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Save failed');

    formStatus.textContent = `${page.id} saved.`;
    loadPages();
  } catch (err) {
    formStatus.textContent = err.message;
  }
});

loadLanding();
loadPages();
