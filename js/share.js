// js/share.js — Reusable rich share module
// 3C Notice Board · 3C Thread To Success™
//
// Handles sharing a specific page across all platforms:
// - Mobile: Web Share API with image thumbnail + title + description
// - Desktop: clipboard copy of formatted text + page URL
// - OG meta tags on the Worker side handle social preview cards
//   when the link is pasted into Twitter, Telegram, WhatsApp desktop, email, etc.
//
// Usage:
//   import { sharePage } from '../js/share.js';
//   await sharePage({ projectId, pageId, pageIndex, pageCount,
//                     projectTitle, imageSrc, description });

const DEFAULT_DESCRIPTION =
  'Welcome to the 3C Thread To Success where ideas become action. Discover ' +
  'practical insights and resources designed to inspire growth, lifelong ' +
  'learning, and meaningful progress.';

/**
 * Builds the page-specific shareable URL.
 * Format: https://…/public/?project=02#page=12
 */
function buildShareUrl(projectId, pageId) {
  const base = `${window.location.origin}${window.location.pathname}`;
  return `${base}?project=${encodeURIComponent(projectId)}#page=${encodeURIComponent(pageId)}`;
}

/**
 * Fetches the image as a small thumbnail blob for Web Share API.
 * Returns null on failure — caller falls through to text-only share.
 */
async function fetchThumbnailBlob(src) {
  try {
    // Draw onto a small canvas to create a thumbnail, keeping aspect ratio
    const img    = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise((res, rej) => {
      img.onload  = res;
      img.onerror = rej;
      img.src     = src;
    });

    const MAX   = 400; // thumbnail max dimension in px
    const ratio = Math.min(MAX / img.width, MAX / img.height, 1);
    const w     = Math.round(img.width  * ratio);
    const h     = Math.round(img.height * ratio);

    const canvas  = document.createElement('canvas');
    canvas.width  = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);

    return await new Promise((res) =>
      canvas.toBlob((b) => res(b), 'image/jpeg', 0.82)
    );
  } catch {
    return null;
  }
}

/**
 * Main share function. Call on every share button click.
 *
 * @param {object} opts
 * @param {string} opts.projectId    — project ID from URL
 * @param {string} opts.pageId       — current page's ID (from pages array)
 * @param {number} opts.pageIndex    — 1-based page number for display
 * @param {number} opts.pageCount    — total pages
 * @param {string} opts.projectTitle — project title, e.g. "3C News Page - 2025"
 * @param {string} opts.imageSrc     — full URL of the current page image
 * @param {string} [opts.description]— optional override description
 * @returns {Promise<'shared'|'copied'>}
 */
export async function sharePage({
  projectId,
  pageId,
  pageIndex,
  pageCount,
  projectTitle,
  imageSrc,
  description = DEFAULT_DESCRIPTION,
}) {
  const shareUrl  = buildShareUrl(projectId, pageId);
  const shareTitle = `${projectTitle} · Page ${pageIndex} of ${pageCount}`;
  const shareText  = description;

  // ── Mobile: Web Share API ──────────────────────────────────────────
  // Try sharing with a thumbnail image first (WhatsApp, Telegram, etc.
  // show the image inline). Fall through gracefully on any failure.
  if (navigator.share) {
    // Attempt with thumbnail blob
    const blob = await fetchThumbnailBlob(imageSrc);
    if (blob) {
      const file = new File([blob], `3c-notice-page-${pageIndex}.jpg`, { type: 'image/jpeg' });
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({
            title: shareTitle,
            text:  shareText,
            url:   shareUrl,
            files: [file],
          });
          return 'shared';
        } catch { /* user cancelled or unsupported — fall through */ }
      }
    }

    // Attempt without image (title + description + URL)
    try {
      await navigator.share({ title: shareTitle, text: shareText, url: shareUrl });
      return 'shared';
    } catch { /* fall through to clipboard */ }
  }

  // ── Desktop fallback: clipboard copy ──────────────────────────────
  // Formatted text block — pastes cleanly into email, Slack, etc.
  const clipText = `${shareTitle}\n${shareText}\n\n${shareUrl}`;
  await navigator.clipboard.writeText(clipText);
  return 'copied';
}
