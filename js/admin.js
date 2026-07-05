// js/admin.js — 3C Notice Board admin panel logic

import { requireLogin, authFetch, publicFetch, logout } from './auth.js';
import { icon } from './icons.js';

requireLogin();

document.getElementById('logoutBtn').addEventListener('click', logout);

const archiveBody = document.getElementById('archiveBody');
const pageForm    = document.getElementById('pageForm');
const formStatus  = document.getElementById('formStatus');
const submitBtn   = document.getElementById('submitBtn');

const pageTypeInput   = document.getElementById('pageType');
const mediaTypeInput  = document.getElementById('mediaType');
const fileInput       = document.getElementById('fileInput');
const urlInput        = document.getElementById('urlInput');
const shareableInput  = document.getElementById('shareableInput');
const landingInput    = document.getElementById('landingInput');

let editingId = null; // set when Edit is clicked, cleared on save/cancel

function publicPageUrl(id) {
  return `${window.location.origin}/3c-notice-board/public/#page=${id}`;
}

async function loadPages() {
  const res = await publicFetch('/api/pages');
  const pages = await res.json();
  renderArchive(pages);
}

function renderArchive(pages) {
  archiveBody.innerHTML = '';
  pages.forEach(page => {
    const src = page.external_url || page.r2_key || '';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${page.id}${page.is_landing ? ' <span style="color:var(--text-muted);font-size:10px;">(landing)</span>' : ''}</td>
      <td>${page.page_type}</td>
      <td>${page.media_type}</td>
      <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${src}</td>
      <td>${page.shareable ? 'Yes' : 'No'}</td>
      <td class="actions-cell">
        <button class="icon-btn" data-action="edit" data-id="${page.id}" title="Edit">${icon('edit')}</button>
        <button class="icon-btn" data-action="copy" data-id="${page.id}" title="Copy URL">${icon('share')}</button>
        <button class="icon-btn" data-action="open" data-id="${page.id}" title="Open in new tab">${icon('link')}</button>
        <button class="icon-btn" data-action="delete" data-id="${page.id}" title="Delete">${icon('delete')}</button>
      </td>
    `;
    archiveBody.appendChild(tr);
  });

  const pageById = Object.fromEntries(pages.map(p => [p.id, p]));

  archiveBody.querySelectorAll('[data-action="edit"]').forEach(btn => {
    btn.addEventListener('click', () => startEdit(pageById[btn.dataset.id]));
  });
  archiveBody.querySelectorAll('[data-action="copy"]').forEach(btn => {
    btn.addEventListener('click', () => copyUrl(btn.dataset.id, btn));
  });
  archiveBody.querySelectorAll('[data-action="open"]').forEach(btn => {
    btn.addEventListener('click', () => window.open(publicPageUrl(btn.dataset.id), '_blank', 'noopener'));
  });
  archiveBody.querySelectorAll('[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', () => deletePage(btn.dataset.id));
  });
}

function startEdit(page) {
  editingId = page.id;
  pageTypeInput.value  = page.page_type;
  mediaTypeInput.value = page.media_type;
  urlInput.value       = page.external_url || '';
  shareableInput.checked = !!page.shareable;
  landingInput.checked   = !!page.is_landing;
  fileInput.value = '';
  submitBtn.textContent = `Update ${page.id}`;
  formStatus.textContent = `Editing ${page.id} — upload a new file only if replacing the media.`;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetForm() {
  editingId = null;
  pageForm.reset();
  submitBtn.textContent = '+ Add Page';
}

async function copyUrl(id, btn) {
  await navigator.clipboard.writeText(publicPageUrl(id));
  const original = btn.innerHTML;
  btn.innerHTML = icon('save');
  setTimeout(() => { btn.innerHTML = original; }, 1200);
}

async function deletePage(id) {
  if (!confirm(`Delete ${id}? This cannot be undone.`)) return;
  await authFetch(`/api/pages/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (editingId === id) resetForm();
  loadPages();
}

pageForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  formStatus.textContent = '';

  const pageType    = pageTypeInput.value;
  const mediaType   = mediaTypeInput.value;
  const file        = fileInput.files[0];
  const externalUrl = urlInput.value.trim();
  const shareable   = shareableInput.checked;
  const isLanding   = landingInput.checked;

  if (!editingId && !file && !externalUrl) {
    formStatus.textContent = 'Upload a file or paste an existing URL — one is required.';
    return;
  }

  try {
    let r2Key = null;

    if (file) {
      formStatus.textContent = 'Uploading…';
      const formData = new FormData();
      formData.append('file', file);
      const uploadRes = await authFetch('/api/upload', { method: 'POST', body: formData });
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) throw new Error(uploadData.error || 'Upload failed');
      r2Key = uploadData.r2_key;
    }

    const body = {
      page_type: pageType,
      media_type: mediaType,
      shareable,
      is_landing: isLanding,
    };
    // Only overwrite the media source if a new file was uploaded or a
    // URL was typed — editing other fields shouldn't wipe existing media.
    if (r2Key) {
      body.r2_key = r2Key;
      body.external_url = null;
    } else if (externalUrl) {
      body.external_url = externalUrl;
      body.r2_key = null;
    }

    if (editingId) {
      formStatus.textContent = 'Saving changes…';
      const res = await authFetch(`/api/pages/${encodeURIComponent(editingId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Update failed');
      formStatus.textContent = `${editingId} updated.`;
    } else {
      formStatus.textContent = 'Saving page…';
      const res = await authFetch('/api/pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
      const created = await res.json();
      formStatus.textContent = `${created.id} added.`;
    }

    resetForm();
    loadPages();
  } catch (err) {
    formStatus.textContent = err.message;
  }
});

loadPages();
