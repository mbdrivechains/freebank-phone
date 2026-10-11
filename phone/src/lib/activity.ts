// Recent activity on this phone, for "Include recent activity" in a report (Report.svelte): the latest events (the
// link to the desktop, each request's outcome, pairing, errors), masked, to the minute, kept in this page's memory
// only and gone when it closes. Nothing leaves the phone unless the user ticks the box, sees these very lines, and
// sends the report.

const MAX_LINES = 60;
const MAX_LINE = 300;
const lines: string[] = [];

/** Masks what could identify the user or their coins: pairing links, passwords in URLs, transaction ids and other
 *  hex, coin addresses, IP addresses (v4 and v6), amounts, numbers of four or more digits (error texts carry amounts
 *  without a unit), and other long tokens (keys, room ids). */
export function mask(s: string): string {
  return s
    .replace(/#pair=[A-Za-z0-9_-]*/g, '#pair=<link>')
    .replace(/:\/\/[^\s/@]*@/g, '://<user>@')
    .replace(/\b[0-9a-fA-F]{64}\b/g, '<txid>')
    .replace(/\b(?:btx|bc|tb|bcrt|ecash|fbk)1[02-9ac-hj-np-z]{6,90}\b/gi, '<address>')
    .replace(/\b(?=[1-9A-HJ-NP-Za-km-z]*\d)(?=[1-9A-HJ-NP-Za-km-z]*[A-Za-z])[1-9A-HJ-NP-Za-km-z]{25,39}\b/g, '<address>')
    .replace(/(^|[^\w:])((?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F.]*)/g, (m, pre, ip) =>
      /::|(?:.*:){3}/.test(ip) && /[0-9a-fA-F]/.test(ip) ? `${pre}<ip>` : m)
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>')
    .replace(/\b(?=[0-9a-fA-F]*\d)(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{8,}\b/g, '<hex>')
    .replace(/\b\d+(?:\.\d+)?(?=\s*(?:s?ECX|BTC|sats?|satoshis?|units?|coins?)\b)/gi, '<amount>')
    .replace(/\b\d{4,}(?:\.\d+)?\b/g, '<n>')
    .replace(/[A-Za-z0-9_+/=-]{40,}/g, '<id>');
}

/** Note one event, masked, with the time (UTC, to the minute). */
export function note(event: string): void {
  const flat = event.replace(/\s+/g, ' ').trim();
  const line = Array.from(mask(flat)).slice(0, MAX_LINE).join(''); // whole characters, never half an emoji
  lines.push(`${new Date().toISOString().slice(11, 16)} ${line}`);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
}

/** The noted events, oldest first, one per line. */
export function recentActivity(): string {
  return lines.join('\n');
}
