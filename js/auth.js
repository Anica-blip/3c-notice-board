// js/auth.js — 3C Notice Board
// 3C Thread To Success™
//
// Client-side session helper. Token lives in localStorage (not cookies —
// this front-end and the Worker are different origins). Update
// WORKER_BASE once you know your deployed Worker's address.

const WORKER_BASE = 'https://3c-notice-board.YOUR-SUBDOMAIN.workers.dev'; // ⚠️ replace after first deploy
const TOKEN_KEY = '3c_nb_token';

export function redirectToLogin() {
  window.location.href = `${WORKER_BASE}/auth/login`;
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function isLoggedIn() {
  return !!getToken();
}

// Called on login.html — if a session already exists, skip straight
// to the admin panel instead of showing the login button again.
export function redirectIfLoggedIn() {
  if (isLoggedIn()) {
    window.location.href = './index.html';
  }
}

// Called on index.html — captures the token the Worker attaches as a
// URL fragment after a successful login, then cleans the URL so the
// token doesn't linger in browser history.
export function captureTokenFromRedirect() {
  const hash = window.location.hash;
  if (hash.startsWith('#token=')) {
    const token = decodeURIComponent(hash.slice(7));
    localStorage.setItem(TOKEN_KEY, token);
    history.replaceState(null, '', window.location.pathname);
  }
}

// Called on index.html on load — if there's no session at all (no
// token in storage, none in the URL either), send back to login.
export function requireLogin() {
  captureTokenFromRedirect();
  if (!isLoggedIn()) {
    window.location.href = './login.html';
  }
}

export function logout() {
  localStorage.removeItem(TOKEN_KEY);
  window.location.href = './login.html';
}

// Wrapper for all authenticated calls to the Worker's /api/* routes.
export async function authFetch(path, options = {}) {
  const token = getToken();
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
  const res = await fetch(`${WORKER_BASE}${path}`, { ...options, headers });
  if (res.status === 401) {
    logout();
    throw new Error('Session expired — please log in again.');
  }
  return res;
}

// Public reads (no auth needed) still go through the same Worker base.
export async function publicFetch(path, options = {}) {
  return fetch(`${WORKER_BASE}${path}`, options);
}

export { WORKER_BASE };
