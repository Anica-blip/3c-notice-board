// js/landing.js — 3C Notice Board Landing Cover tool
// Cloned interaction pattern from the Card Showcase landing-upload
// tool: drag-and-drop, animated progress, result block with copy URL.
// No Supabase — this project has none; the two steps here are upload
// to R2, then update that project's landing.json.

import { requireLogin, authFetch, logout } from './auth.js';

requireLogin();

const projectSelect      = document.getElementById('projectSelect');
const uploadArea         = document.getElementById('uploadArea');
const fileInput          = document.getElementById('fileInput');
const chosenFileName     = document.getElementById('chosenFileName');
const previewPlaceholder = document.getElementById('previewPlaceholder');
const previewWrap        = document.getElementById('previewWrap');
const progressWrap       = document.getElementById('progressWrap');
const progressBar        = document.getElementById('progressBar');
const statusMsg          = document.getElementById('statusMsg');
const resultBlock        = document.getElementById('resultBlock');
const resultUrl          = document.getElementById('resultUrl');
const copiedMsg          = document.getElementById('copiedMsg');
const btnUpload          = document.getElementById('btnUpload');

let selectedFile = null;

/* ── Load projects dropdown ────────────────────────── */
async function loadProjects() {
  try {
    const res = await authFetch('/api/projects');
    const projects = await res.json();

    if (!projects.length) {
      projectSelect.innerHTML = '<option value="">No saved projects found — save one first</option>';
      return;
    }

    projectSelect.innerHTML = '<option value="">— Choose a project —</option>' +
      projects.map(p => `<option value="${p.id}">${p.id} — ${p.title}</option>`).join('');
  } catch (err) {
    projectSelect.innerHTML = `<option value="">Error: ${err.message}</option>`;
  }
}

projectSelect.addEventListener('change', checkReady);

/* ── File handlers (drag-and-drop + click-to-choose) ── */
window.handleFileSelect = function (input) {
  const file = input.files[0];
  if (!file) return;
  setFile(file);
};

window.handleDragOver = function (e) {
  e.preventDefault();
  uploadArea.classList.add('dragover');
};

window.handleDragLeave = function () {
  uploadArea.classList.remove('dragover');
};

window.handleDrop = function (e) {
  e.preventDefault();
  uploadArea.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (!file) return;
  setFile(file);
};

function setFile(file) {
  selectedFile = file;
  chosenFileName.textContent = file.name;

  previewPlaceholder.style.display = 'none';
  previewWrap.style.display = 'block';
  previewWrap.innerHTML = '';

  const img = document.createElement('img');
  img.src = URL.createObjectURL(file);
  img.alt = 'Preview';
  previewWrap.appendChild(img);

  checkReady();
}

function checkReady() {
  btnUpload.disabled = !(projectSelect.value && selectedFile);
}

/* ── Upload cover to R2, then update this project's landing.json ── */
window.uploadCover = async function () {
  const projectId = projectSelect.value;
  if (!projectId || !selectedFile) return;

  setStatus('loading', 'Step 1 of 2 — Uploading cover image to R2…');
  showProgress(true);
  btnUpload.disabled = true;
  resultBlock.style.display = 'none';

  try {
    animateProgress(0, 55, 700);

    const formData = new FormData();
    formData.append('file', selectedFile);
    const uploadRes = await authFetch(`/api/projects/${encodeURIComponent(projectId)}/upload`, {
      method: 'POST',
      body: formData,
    });
    if (!uploadRes.ok) {
      const err = await uploadRes.json().catch(() => ({}));
      throw new Error(err.error || `Upload error ${uploadRes.status}`);
    }
    const { r2_key, url } = await uploadRes.json();
    const coverUrl = `${url}?v=${Date.now()}`; // cache-bust so the CDN serves the fresh image

    setStatus('loading', "Step 2 of 2 — Saving as this project's landing cover…");
    animateProgress(55, 90, 400);

    const landingRes = await authFetch(`/api/projects/${encodeURIComponent(projectId)}/landing`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ r2_key, external_url: null }),
    });
    if (!landingRes.ok) throw new Error(`Landing save failed (${landingRes.status})`);

    animateProgress(90, 100, 200);

    setTimeout(() => {
      showProgress(false);
      setStatus('success', `Done! Cover saved for ${projectId}.\nFile: ${r2_key}`);
      resultUrl.value = coverUrl;
      resultBlock.style.display = 'flex';
      btnUpload.disabled = false;
    }, 350);

  } catch (err) {
    showProgress(false);
    setStatus('error', err.message);
    btnUpload.disabled = false;
  }
};

/* ── Copy URL ───────────────────────────────────────── */
window.copyUrl = function () {
  resultUrl.select();
  navigator.clipboard.writeText(resultUrl.value);
  copiedMsg.style.display = 'block';
  setTimeout(() => { copiedMsg.style.display = 'none'; }, 1200);
};

/* ── Helpers ────────────────────────────────────────── */
function setStatus(type, msg) {
  statusMsg.className = type;
  statusMsg.textContent = msg;
}

function showProgress(show) {
  progressWrap.style.display = show ? 'block' : 'none';
  if (!show) progressBar.style.width = '0%';
}

function animateProgress(from, to, duration) {
  const steps = 20;
  const step = (to - from) / steps;
  const delay = duration / steps;
  let current = from;
  const interval = setInterval(() => {
    current += step;
    progressBar.style.width = Math.min(current, to) + '%';
    if (current >= to) clearInterval(interval);
  }, delay);
}

/* ── Logout (no dedicated button on this page — Back link returns to Admin) ── */
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.location.href = 'index.html';
});

loadProjects();
