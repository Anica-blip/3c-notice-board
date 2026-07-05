// admin/admin.js — 3C Notice Board admin panel logic

import { requireLogin, authFetch, publicFetch, logout } from './auth.js';
import { icon } from './icons.js';

requireLogin();

document.getElementById('logoutBtn').innerHTML = icon('back');
document.getElementById('logoutBtn').addEventListener('click', logout);
document.getElementById('submitIcon').innerHTML = icon('upload');

const pageList   = document.getElementById('pageList');
const pageForm   = document.getElementById('pageForm');
const formStatus = document.getElementById('formStatus');

async function loadPages() {
  const res = await publicFetch('/api/pages');
  const pages = await res.json();
  renderPages(pages);
}

function renderPages(pages) {
  pageList.innerHTML = '';
  pages.forEach(page => {
    const card = document.createElement('div');
    card.className = 'page-card';
    const src = page.external_url || page.r2_key || '';
    card.innerHTML = `
      <div class="meta">
        <strong>${page.is_landing ? 'Landing · ' : ''}${page.page_type} / ${page.media_type}</strong><br>
        ${src}
      </div>
      <div class="actions">
        <button class="icon-btn" data-action="delete" data-id="${page.id}">${icon('delete')}</button>
      </div>
    `;
    pageList.appendChild(card);
  });

  pageList.querySelectorAll('[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', () => deletePage(btn.dataset.id));
  });
}

async function deletePage(id) {
  if (!confirm('Delete this page?')) return;
  await authFetch(`/api/pages/${encodeURIComponent(id)}`, { method: 'DELETE' });
  loadPages();
}

pageForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  formStatus.textContent = '';

  const pageType   = document.getElementById('pageType').value;
  const mediaType  = document.getElementById('mediaType').value;
  const file        = document.getElementById('fileInput').files[0];
  const externalUrl = document.getElementById('urlInput').value.trim();
  const shareable    = document.getElementById('shareableInput').checked;
  const isLanding    = document.getElementById('landingInput').checked;

  if (!file && !externalUrl) {
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

    formStatus.textContent = 'Saving page…';
    const createRes = await authFetch('/api/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        page_type: pageType,
        media_type: mediaType,
        r2_key: r2Key,
        external_url: r2Key ? null : (externalUrl || null),
        shareable,
        is_landing: isLanding,
      }),
    });
    if (!createRes.ok) throw new Error((await createRes.json()).error || 'Save failed');

    formStatus.textContent = 'Page added.';
    pageForm.reset();
    loadPages();
  } catch (err) {
    formStatus.textContent = err.message;
  }
});

loadPages();
