// js/admin.js — 3C Notice Board admin panel logic
// Pages are plain A4 files the admin uploads and manages — no shape
// selection, no canvas fitting. Title and pages build up in local
// memory (matching builder.js's addCard/removeCardAt/moveCard exactly:
// instant, local, no network call). Files are also deferred now —
// selecting one just gives a local blob preview (pendingFiles map,
// same pattern as builder.js's pendingCardFiles); the actual upload to
// R2 only happens for real when you click Save, one pass over
// whichever pages still have a pending file.

import { requireLogin, authFetch, logout, WORKER_BASE } from './auth.js';
import { icon } from './icon.js';

requireLogin();
document.getElementById('logoutBtn').addEventListener('click', logout);

function friendlyError(err) {
  if (err.message === 'Failed to fetch' || err instanceof TypeError) {
    return `Worker not reachable at ${WORKER_BASE} — is it deployed yet? Check js/auth.js WORKER_BASE if the address changed.`;
  }
  return err.message;
}

/* ══════════════════ STATE ══════════════════ */

let currentProjectId = null;
let pages = [];
let selectedIndex = -1;
let localIdCounter = 0;
let pendingFiles = {};

/* ══════════════════ ELEMENTS ══════════════════ */

const projectTitleInput = document.getElementById('projectTitleInput');
const titleLabel        = document.getElementById('titleLabel');
const projectUrlDisplay = document.getElementById('projectUrlDisplay');
const projectStatus     = document.getElementById('projectStatus');
const saveProjectBtn    = document.getElementById('saveProjectBtn');

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

const pageDetails = document.getElementById('pageDetails');
const shareableInput = document.getElementById('shareableInput');

const archiveBody = document.getElementById('archiveBody');

/* ══════════════════ SAVE ══════════════════ */

let nextIdPreview = null;

async function loadNextIdPreview() {
  try {
    const res = await authFetch('/api/projects');
    const projects = await res.json();
    const max = projects.reduce((m, p) => Math.max(m, parseInt(p.id, 10) || 0), 0);
    nextIdPreview = String(max + 1).padStart(2, '0');
  } catch {
    nextIdPreview = '—';
  }
  updateTitleLabel();
}

function updateTitleLabel() {
  titleLabel.textContent = currentProjectId
    ? `Editing #${currentProjectId}`
    : `New Title #${nextIdPreview ?? '—'}`;
}

function hasUnsavedWork() {
  return projectTitleInput.value.trim() !== '' || pages.length > 0;
}

saveProjectBtn.addEventListener('click', async () => {
  const title = projectTitleInput.value.trim();
  if (!title) {
    alert('Add a title to save this project');
    return;
  }

  projectStatus.textContent = 'Saving to R2 bucket…';

  try {
    const pageIdsWithPending = Object.keys(pendingFiles);
    for (let i = 0; i < pageIdsWithPending.length; i++) {
      const pageId = pageIdsWithPending[i];
      const file = pendingFiles[pageId];
      const page = pages.find(p => p.id === pageId);
      if (!page || !file) continue;

      projectStatus.textContent = `Saving to R2 bucket… (${i + 1} of ${pageIdsWithPending.length} files)`;
      const formData = new FormData();
      formData.append('file', file);
      const uploadRes = await authFetch('/api/upload', { method: 'POST', body: formData });
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) throw new Error(uploadData.error || `Upload failed for ${pageId}`);
      page.r2_key = uploadData.r2_key;
      page.external_url = null;
    }
    pendingFiles = {};

    projectStatus.textContent = 'Saving to R2 bucket…';

    const outgoingPages = pages.map(({ id, media_type, r2_key, external_url, shareable }) => ({
      id: id.startsWith('local-') ? undefined : id,
      media_type, r2_key, external_url, shareable,
    }));

    if (!currentProjectId) {
      const res = await authFetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, pages: outgoingPages }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
      const project = await res.json();

      projectStatus.textContent = '';
      alert(`Saved to R2 bucket\n\n${project.id} — ${project.cloudflare_url}`);
      await loadArchive();
      await loadNextIdPreview();
      resetWorkspace();
    } else {
      const res = await authFetch(`/api/projects/${encodeURIComponent(currentProjectId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, pages: outgoingPages }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
      const project = await res.json();

      projectStatus.textContent = '';
      alert(`Saved to R2 bucket\n\n${project.id} — ${project.cloudflare_url}`);
      await loadArchive();
      resetWorkspace();
    }
  } catch (err) {
    projectStatus.textContent = friendlyError(err);
  }
});

function resetWorkspace() {
  currentProjectId = null;
  projectTitleInput.value = '';
  projectUrlDisplay.value = '';
  updateTitleLabel();
  pages = [];
  pendingFiles = {};
  selectedIndex = -1;
  renderGrid();
  renderSelected();
}

window.addEventListener('beforeunload', (e) => {
  if (hasUnsavedWork()) {
    e.preventDefault();
    e.returnValue = '';
  }
});

/* ══════════════════ ARCHIVE ══════════════════ */

async function loadArchive() {
  try {
    const res = await authFetch('/api/projects');
    const projects = await res.json();
    renderArchive(projects);
  } catch (err) {
    archiveBody.innerHTML = `<tr><td colspan="5" style="color:var(--danger);">${friendlyError(err)}</td></tr>`;
  }
}

function renderArchive(projects) {
  archiveBody.innerHTML = '';
  if (!projects.length) {
    archiveBody.innerHTML = '<tr><td colspan="5" style="color:var(--text-muted);">No saved projects yet.</td></tr>';
    return;
  }

  projects.forEach(p => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.id}</td>
      <td>${p.title}</td>
      <td>${p.page_count ?? 0}</td>
      <td class="url-cell">${p.cloudflare_url}</td>
      <td class="actions-cell">
        <button class="icon-btn" data-action="edit" data-id="${p.id}" title="Edit">${icon('edit')}</button>
        <button class="icon-btn" data-action="open" data-id="${p.id}" data-url="${p.cloudflare_url}" title="View">${icon('link')}</button>
        <button class="icon-btn" data-action="delete" data-id="${p.id}" title="Delete">${icon('delete')}</button>
      </td>
    `;
    archiveBody.appendChild(tr);
  });

  archiveBody.querySelectorAll('[data-action="edit"]').forEach(btn => {
    btn.addEventListener('click', () => loadProjectIntoWorkspace(btn.dataset.id));
  });
  archiveBody.querySelectorAll('[data-action="open"]').forEach(btn => {
    btn.addEventListener('click', () => window.open(btn.dataset.url, '_blank', 'noopener'));
  });
  archiveBody.querySelectorAll('[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', () => deleteProject(btn.dataset.id));
  });
}

async function loadProjectIntoWorkspace(id) {
  try {
    projectStatus.textContent = 'Loading project…';
    const projectsRes = await authFetch('/api/projects');
    const projects = await projectsRes.json();
    const project = projects.find(p => p.id === id);
    if (!project) throw new Error('Project not found');

    currentProjectId = id;
    projectTitleInput.value = project.title;
    projectUrlDisplay.value = project.cloudflare_url;
    updateTitleLabel();
    projectStatus.textContent = `Editing ${id} — change the title and/or pages, then Save.`;

    const pagesRes = await authFetch(`/api/projects/${encodeURIComponent(id)}/pages`);
    pages = await pagesRes.json();
    pendingFiles = {};
    selectedIndex = pages.length ? 0 : -1;
    renderGrid();
    renderSelected();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    projectStatus.textContent = friendlyError(err);
  }
}

async function deleteProject(id) {
  if (!confirm(`Delete project ${id}? This removes all its pages and media permanently.`)) return;
  try {
    await authFetch(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (currentProjectId === id) resetWorkspace();
    loadArchive();
  } catch (err) {
    projectStatus.textContent = friendlyError(err);
  }
}

/* ══════════════════ BUILDER (matches builder.js: local, instant) ══════════════════ */

function selectedPage() {
  return selectedIndex >= 0 ? pages[selectedIndex] : null;
}

function mediaSrc(page) {
  return page.localPreview || page.external_url || page.r2_key || '';
}

function renderSelected() {
  const page = selectedPage();

  if (!page) {
    cardPreviewLarge.innerHTML = '<div class="card-preview-empty">No pages yet<br/>Click + Add</div>';
    navCounter.textContent = '0 of 0';
    pageDetails.innerHTML = '';
    pageForm.style.opacity = '0.4';
    pageForm.style.pointerEvents = 'none';
    return;
  }

  pageForm.style.opacity = '1';
  pageForm.style.pointerEvents = 'auto';

  const src = mediaSrc(page);

  if (page.media_type === 'image') {
    cardPreviewLarge.innerHTML = src
      ? `<img src="${src}" alt="Page ${selectedIndex + 1}" />`
      : '<div class="card-preview-empty">No image<br/>Upload below</div>';
  } else if (page.media_type === 'video') {
    cardPreviewLarge.innerHTML = src
      ? `<video src="${src}" muted playsinline preload="metadata"></video>`
      : '<div class="card-preview-empty">No video<br/>Upload below</div>';
  } else {
    cardPreviewLarge.innerHTML = src
      ? `<div class="card-preview-empty">Audio page<br/>${src.split('/').pop()}</div>`
      : '<div class="card-preview-empty">No audio<br/>Upload below</div>';
  }

  navCounter.textContent = `${selectedIndex + 1} of ${pages.length}`;
  navPrev.disabled = selectedIndex <= 0;
  navNext.disabled = selectedIndex >= pages.length - 1;
  shareableInput.checked = !!page.shareable;

  // Rebuilt every time, exactly like builder.js's card-details —
  // media-type button group, then a green upload button whose label
  // switches with the type, then the R2-URL fallback row.
  const acceptType = page.media_type === 'video' ? 'video/*' : page.media_type === 'audio' ? 'audio/*' : 'image/*';
  const uploadLabel = page.media_type === 'video' ? 'Upload Video' : page.media_type === 'audio' ? 'Upload Audio' : 'Upload Image';

  pageDetails.innerHTML = `
    <div class="card-detail-row">
      <label class="field-label">Media Type</label>
      <div class="shape-selector">
        <button type="button" class="shape-btn ${page.media_type === 'image' ? 'active' : ''}" data-media="image">Image</button>
        <button type="button" class="shape-btn ${page.media_type === 'video' ? 'active' : ''}" data-media="video">Video</button>
        <button type="button" class="shape-btn ${page.media_type === 'audio' ? 'active' : ''}" data-media="audio">Audio</button>
      </div>
    </div>
    <div class="card-detail-row" style="margin-top:10px;">
      <label class="upload-btn-green" for="fileInput">⇧ ${uploadLabel}</label>
      <input type="file" id="fileInput" accept="${acceptType}" style="display:none;" />
      <div class="r2-url-row">
        <span class="r2-or">or paste R2 URL</span>
        <input type="text" id="urlInput" class="r2-url-input" placeholder="https://files.3c-public-library.org/…" value="${page.external_url || ''}" />
      </div>
    </div>
  `;

  pageDetails.querySelectorAll('[data-media]').forEach(btn => {
    btn.addEventListener('click', () => setMediaType(btn.dataset.media));
  });

  document.getElementById('fileInput').addEventListener('change', handleFileChange);
  document.getElementById('urlInput').addEventListener('input', handleUrlInput);
}

function setMediaType(type) {
  const page = selectedPage();
  if (!page) return;
  page.media_type = type;
  page.localPreview = '';
  delete pendingFiles[page.id];
  renderSelected();
  renderGrid();
}

function handleFileChange(e) {
  const page = selectedPage();
  const file = e.target.files[0];
  if (!page || !file) return;

  pendingFiles[page.id] = file;
  page.localPreview = URL.createObjectURL(file);
  page.r2_key = null;
  page.external_url = null;

  renderGrid();
  renderSelected();
}

function handleUrlInput(e) {
  const page = selectedPage();
  if (!page) return;
  const url = e.target.value.trim();

  page.external_url = url || null;
  if (url) {
    page.r2_key = null;
    page.localPreview = '';
    delete pendingFiles[page.id];
  }
  renderGrid();
}

function renderGrid() {
  cardCount.textContent = `${pages.length} page${pages.length === 1 ? '' : 's'}`;

  if (pages.length === 0) {
    cardGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;font-size:13px;color:var(--text-muted);">No pages yet. Click + Add to start.</div>';
    return;
  }

  cardGrid.innerHTML = '';
  pages.forEach((page, i) => {
    const src = mediaSrc(page);
    const cell = document.createElement('div');
    cell.className = `grid-card${i === selectedIndex ? ' selected' : ''}`;
    cell.title = `Page ${i + 1} — click to select`;

    let thumbHtml;
    if (page.media_type === 'image') {
      thumbHtml = src
        ? `<img class="grid-card-thumb" src="${src}" alt="Page ${i + 1}" />`
        : `<div class="grid-card-icon">${icon('edit')}</div>`;
    } else if (page.media_type === 'video') {
      thumbHtml = src
        ? `<video class="grid-card-thumb" src="${src}" muted playsinline preload="metadata"></video>`
        : `<div class="grid-card-icon">${icon('play')}</div>`;
    } else {
      thumbHtml = `<div class="grid-card-icon">${icon('link')}</div>`;
    }

    cell.innerHTML = `
      <span class="card-number">${i + 1}</span>
      <div class="card-reorder">
        <button class="reorder-btn" data-action="up" data-idx="${i}" ${i === 0 ? 'disabled' : ''}>▲</button>
        <button class="reorder-btn" data-action="down" data-idx="${i}" ${i === pages.length - 1 ? 'disabled' : ''}>▼</button>
      </div>
      <button class="card-remove" data-action="remove" data-idx="${i}">×</button>
      ${thumbHtml}
      <div class="grid-card-label">${page.media_type}</div>
    `;

    cell.addEventListener('click', (e) => {
      if (e.target.closest('[data-action]')) return;
      selectedIndex = i;
      renderGrid();
      renderSelected();
    });

    cardGrid.appendChild(cell);
  });

  cardGrid.querySelectorAll('[data-action="up"]').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); moveCard(+btn.dataset.idx, -1); }));
  cardGrid.querySelectorAll('[data-action="down"]').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); moveCard(+btn.dataset.idx, 1); }));
  cardGrid.querySelectorAll('[data-action="remove"]').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); removeCard(+btn.dataset.idx); }));
}

function moveCard(idx, direction) {
  const swapWith = idx + direction;
  if (swapWith < 0 || swapWith >= pages.length) return;
  const selectedId = selectedPage()?.id;
  [pages[idx], pages[swapWith]] = [pages[swapWith], pages[idx]];
  if (selectedId) selectedIndex = pages.findIndex(p => p.id === selectedId);
  renderGrid();
  renderSelected();
}

function removeCard(idx) {
  if (!confirm('Remove this page from the project?')) return;
  const [removed] = pages.splice(idx, 1);
  if (removed) delete pendingFiles[removed.id];
  selectedIndex = pages.length ? Math.min(idx, pages.length - 1) : -1;
  renderGrid();
  renderSelected();
}

addPageBtn.addEventListener('click', () => {
  const newPage = {
    id: `local-${++localIdCounter}`,
    media_type: 'image',
    r2_key: null,
    external_url: null,
    shareable: true,
    localPreview: '',
  };
  pages.push(newPage);
  selectedIndex = pages.length - 1;
  renderGrid();
  renderSelected();
});

navPrev.addEventListener('click', () => { if (selectedIndex > 0) { selectedIndex--; renderGrid(); renderSelected(); } });
navNext.addEventListener('click', () => { if (selectedIndex < pages.length - 1) { selectedIndex++; renderGrid(); renderSelected(); } });

pageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const page = selectedPage();
  if (!page) return;

  page.shareable = shareableInput.checked;

  formStatus.textContent = 'Updated locally — click Save (top of page) to persist.';
  renderGrid();
});

/* ══════════════════ INIT ══════════════════ */

renderGrid();
renderSelected();
loadArchive();
loadNextIdPreview();
