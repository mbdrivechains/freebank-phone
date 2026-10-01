import { writable } from 'svelte/store';

// The phone page on a Home Screen (app v0.2.1). iOS gives a Home Screen icon its own storage, so an icon
// pairs itself: it scans the desktop's QR code ("Scan the code on your desktop", lib/scan.ts, since v0.2.2),
// or takes the link with "Paste pairing link".

/** Opened from a Home Screen icon (iOS says so in navigator.standalone; others in the display mode). */
export function standalone(): boolean {
  return (navigator as { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;
}

/** An iPhone or iPad (iPadOS calls itself a Mac, but has touch). */
export function ios(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

/** The pairing link for `value`, on this page. */
export function pairLinkFor(value: string, loc: { origin: string; pathname: string }): string {
  return `${loc.origin}${loc.pathname}#pair=${value}`;
}

/**
 * The `#pair=` value in pasted text: the whole link from the desktop, or the value alone. A link to
 * another site is refused (the link's relay is checked again when it is read). Null for text that
 * holds no pairing link.
 */
export function pairValueFrom(text: string, origin: string): string | null {
  const t = text.trim();
  const at = t.indexOf('#pair=');
  if (at < 0) return /^[A-Za-z0-9_-]{40,}$/.test(t) ? t : null;
  if (/^https?:\/\//i.test(t)) {
    let url: URL;
    try {
      url = new URL(t);
    } catch {
      return null;
    }
    if (url.origin !== origin) throw new Error(`This link is for another site (${url.host}), not this page. Use the link your FreeBank desktop shows.`);
  }
  const v = t.slice(at + '#pair='.length).split(/\s/)[0];
  return v || null;
}


/** Chrome's install prompt (Android; it needs the page's manifest), kept for the Install button. */
export interface InstallPrompt {
  prompt: () => Promise<void>;
}
export const installPrompt = writable<InstallPrompt | null>(null);
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt.set(e as unknown as InstallPrompt);
  });
  window.addEventListener('appinstalled', () => installPrompt.set(null));
}
