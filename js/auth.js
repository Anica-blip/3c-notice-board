// js/auth.js — 3C Notice Board
// 3C Thread To Success™
//
// Sign-in helper. GitHub sign-in runs through Supabase (project
// "Aurion 3C Mascot"); Supabase keeps the session and refreshes it on its
// own, so there is no fixed lock-out date. Only the owner gets in: after
// signing in, the page asks Supabase's is_owner() function. The Worker
// checks the same thing again on every owner-only call, so this file only
// decides what the pages show.
//
// This file is also imported by the public viewer (public/viewer.js) for
// WORKER_BASE. Nothing here touches Supabase until a sign-in function is
// called, so the viewer never loads the sign-in library.

const WORKER_BASE = 'https://3c-notice-board.3c-innertherapy.workers.dev';

// Public values (the anon key is public by design).
const SUPABASE_URL      = 'https://cgxjqsbrditbteqhdyus.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNneGpxc2JyZGl0YnRlcWhkeXVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTExMTY1ODEsImV4cCI6MjA2NjY5MjU4MX0.xUDy5ic-r52kmRtocdcW8Np9-lczjMZ6YKPXc03rIG4';

// All of Chef's GitHub Pages apps share one address (anica-blip.github.io),
// so this app keeps its session under its own name.
const STORAGE_KEY   = 'sb-3c-notice-board-login';
const OLD_TOKEN_KEY = '3c_nb_token'; // from the old home-made login, cleared on sight

let client = null;

function getClient() {
  if (!client) {
    if (!window.supabase) {
      throw new Error('The sign-in library did not load — check your connection and reload.');
    }
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: STORAGE_KEY,
      },
    });
  }
  return client;
}

// Returns { session, notOwner }.
//   session = null                → nobody signed in (or not the owner)
//   notOwner = true               → someone signed in with another account; they are signed out here
// If the owner check cannot be made (for example no network) the session is
// kept and nobody is signed out; the Worker is the real gate.
async function getOwnerSession() {
  const supabase = getClient();
  const { data } = await supabase.auth.getSession();
  const session = data && data.session;
  if (!session) return { session: null, notOwner: false };

  const { data: isOwner, error } = await supabase.rpc('is_owner');
  if (error) return { session, notOwner: false };
  if (isOwner !== true) {
    await supabase.auth.signOut();
    return { session: null, notOwner: true };
  }
  return { session, notOwner: false };
}

export async function redirectToLogin() {
  const { error } = await getClient().auth.signInWithOAuth({
    provider: 'github',
    options: { redirectTo: new URL('index.html', window.location.href).href },
  });
  if (error) throw error;
}

// Called on login.html — if the owner is already signed in, skip straight
// to the admin panel instead of showing the login button again.
export async function redirectIfLoggedIn() {
  const { session } = await getOwnerSession();
  if (session) window.location.href = './index.html';
}

// Called on index.html before anything else runs — no owner session, no admin.
// When it redirects, it never resolves, so the code after it does not run.
export async function requireLogin() {
  localStorage.removeItem(OLD_TOKEN_KEY);
  const { session, notOwner } = await getOwnerSession();
  if (!session) {
    window.location.href = notOwner ? './login.html?notowner=1' : './login.html';
    await new Promise(() => {});
  }
}

export async function logout() {
  try { await getClient().auth.signOut(); } catch { /* leave anyway */ }
  window.location.href = './login.html';
}

async function getAccessToken() {
  const { data } = await getClient().auth.getSession();
  return (data && data.session && data.session.access_token) || null;
}

// Wrapper for all authenticated calls to the Worker's /api/* routes.
export async function authFetch(path, options = {}) {
  const token = await getAccessToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${WORKER_BASE}${path}`, { ...options, headers });
  if (res.status === 401) {
    await logout();
    throw new Error('Session expired — please log in again.');
  }
  return res;
}

// Public reads (no auth needed) still go through the same Worker base.
export async function publicFetch(path, options = {}) {
  return fetch(`${WORKER_BASE}${path}`, options);
}

export { WORKER_BASE };
