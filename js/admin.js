// js/admin.js — 3C Notice Board admin panel logic
// Title + pages are built up in local memory as you work. Add, edit
// fields, reorder, and delete are all instant and local — nothing
// touches the Worker until you click Save, which sends the whole
// project (title + full pages array) in one call. This matches how
// the Card Showcase builder actually works: one document, one save.

import { requireLogin, authFetch, logout, WORKER_BASE } from './auth.js';
import { icon } from './icons.js';

requireLogin();
document.getElementById('logoutBtn').addEventListener('click', logout);

function publicPageUrl(projectId, pageId) {
  return `${window.location.origin}/3c-notice-board/public/?project=${projectId}#page=${pageId}`;
}

function friendlyError(err) {
  if (err.message === 'Failed to fetch' || err instanceof TypeError) {
    return `Worker not reachable at ${WORKER_BASE} — is it deployed yet? Check js/auth.js WORKER_BASE if the address changed.`;
  }
  return err.message;
}

/* ══════════════════ STATE ══════════════════ */
// currentProjectId is null until the first Save. Everything below is
// local until then — this is the fix for "why do I have to save the
// title before I can even add a card."

let currentProjectId = null;
let pages = [];        // local working copy — page ids may be temporary until saved
let selectedIndex = -1;
let localIdCounter = 0; // for temporary client-side keys before a real page-XXX id exists

/* ══════════════════ ELEMENTS ══════════════════ */

const projectTitleInput = document.getElementById('projectTitleInput');
const projectIdBadge    = document.getElementById('projectIdBadge');
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
const copyUrlBtn  = document.getElementById('copyUrlBtn');
const openUrlBtn  = document.getElementById('openUrlBtn');

const pageTypeInput  = document.getElementById('pageType');
const mediaTypeInput = document.getElementById('mediaType');
const fileInput      = document.getElementById('fileInput');
const urlInput       = document.getElementById('urlInput');
const shareableInput = document.getElementById('shareableInput');

const archiveBody = document.getElementById('archiveBody');

/* ══════════════════ SAVE (the only thing that hits the Worker for pages) ══════════════════ */

saveProjectBtn.addEventListener('click', async () => {
  const title = projectTitleInput.value.trim();
  if (!title) {
    projectStatus.textContent = 'Enter a title before saving.';
    return;
  }

  // Strip the temporary local-only fields before sending — the
  // Worker assigns real page-XXX ids to anything without one.
  const outgoingPages = pages.map(({ id, page_type, media_type, r2_key, external_url, shareable }) => ({
    id: id.startsWith('local-') ? undefined : id,
    page_type, media_type, r2_key, external_url, shareable,
  }));

  try {
    if (!currentProjectId) {
      projectStatus.textContent = 'Saving new project…';
      const res = await authFetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, pages: outgoingPages }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
      const project = await res.json();

      projectStatus.textContent = `Saved as ${project.id} — ${project.cloudflare_url}`;
      await loadArchive();
      resetWorkspace();
    } else {
      projectStatus.textContent = 'Saving changes…';
      const res = await authFetch(`/api/projects/${encodeURIComponent(currentProjectId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, pages: outgoingPages }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
      projectStatus.textContent = `${currentProjectId} updated.`;
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
  projectIdBadge.textContent = 'Unsaved';
  pages = [];
  selectedIndex = -1;
  renderGrid();
  renderSelected();
}

/* ══════════════════ ARCHIVE (saved projects) ══════════════════ */

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
    projectIdBadge.textContent = id;
    projectStatus.textContent = `Editing ${id} — change the title and/or pages, then Save.`;

    const pagesRes = await authFetch(`/api/projects/${encodeURIComponent(id)}/pages`);
    pages = await pagesRes.json();
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

/* ══════════════════ TWO-PANEL BUILDER (all local until Save) ══════════════════ */

function selectedPage() {
  return selectedIndex >= 0 ? pages[selectedIndex] : null;
}

function mediaSrc(page) {
  return page.external_url || page.r2_key || '';
}

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
  submitBtn.textContent = currentProjectId ? `Update ${page.id}` : 'Update Page';
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
        <button class="reorder-btn" data-action="up" data-idx="${i}" ${i === 0 ? 'disabled' : ''}>▲</button>
        <button class="reorder-btn" data-action="down" data-idx="${i}" ${i === pages.length - 1 ? 'disabled' : ''}>▼</button>
      </div>
      <button class="card-remove" data-action="remove" data-idx="${i}">×</button>
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

  cardGrid.querySelectorAll('[data-action="up"]').forEach(btn => btn.addEventListener('click', () => moveCard(+btn.dataset.idx, -1)));
  cardGrid.querySelectorAll('[data-action="down"]').forEach(btn => btn.addEventListener('click', () => moveCard(+btn.dataset.idx, 1)));
  cardGrid.querySelectorAll('[data-action="remove"]').forEach(btn => btn.addEventListener('click', () => removeCard(+btn.dataset.idx)));
}

// Reorder, remove, and add are all local array operations now — no
// network round-trip, no waiting, nothing persists until Save.
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
  pages.splice(idx, 1);
  selectedIndex = pages.length ? Math.min(idx, pages.length - 1) : -1;
  renderGrid();
  renderSelected();
}

addPageBtn.addEventListener('click', () => {
  const newPage = {
    id: `local-${++localIdCounter}`,
    page_type: 'portrait',
    media_type: 'image',
    r2_key: null,
    external_url: null,
    shareable: true,
  };
  pages.unshift(newPage);
  selectedIndex = 0;
  renderGrid();
  renderSelected();
});

navPrev.addEventListener('click', () => { if (selectedIndex > 0) { selectedIndex--; renderGrid(); renderSelected(); } });
navNext.addEventListener('click', () => { if (selectedIndex < pages.length - 1) { selectedIndex++; renderGrid(); renderSelected(); } });

copyUrlBtn.addEventListener('click', async () => {
  const page = selectedPage();
  if (!page || !currentProjectId) {
    formStatus.textContent = 'Save the project first — the public URL only exists once saved.';
    return;
  }
  await navigator.clipboard.writeText(publicPageUrl(currentProjectId, page.id));
  formStatus.textContent = 'URL copied.';
});
openUrlBtn.addEventListener('click', () => {
  const page = selectedPage();
  if (!page || !currentProjectId) {
    formStatus.textContent = 'Save the project first — the public URL only exists once saved.';
    return;
  }
  window.open(publicPageUrl(currentProjectId, page.id), '_blank', 'noopener');
});

// The form updates the SELECTED page's fields locally. File uploads
// still hit the Worker immediately (there's no way to preview a file
// without it existing somewhere), but that's the only network call
// here — everything else waits for the toolbar Save.
pageForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const page = selectedPage();
  if (!page) return;
  formStatus.textContent = '';

  const file        = fileInput.files[0];
  const externalUrl = urlInput.value.trim();

  page.page_type  = pageTypeInput.value;
  page.media_type = mediaTypeInput.value;
  page.shareable  = shareableInput.checked;

  try {
    if (file) {
      formStatus.textContent = 'Uploading…';
      const formData = new FormData();
      formData.append('file', file);
      const uploadRes = await authFetch('/api/upload', { method: 'POST', body: formData });
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) throw new Error(uploadData.error || 'Upload failed');
      page.r2_key = uploadData.r2_key;
      page.external_url = null;
    } else if (externalUrl && externalUrl !== (page.external_url || '')) {
      page.external_url = externalUrl;
      page.r2_key = null;
    }

    pages[selectedIndex] = { ...page };
    formStatus.textContent = 'Updated locally — click Save (top of page) to persist.';
    renderGrid();
    renderSelected();
  } catch (err) {
    formStatus.textContent = friendlyError(err);
  }
});

/* ══════════════════ INIT ══════════════════ */

renderGrid();
renderSelected();
loadArchive();
