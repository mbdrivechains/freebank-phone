// "Report a problem or suggest something" on the phone page: posted to this
// site's POST /feedback (relay/src/feedback.rs), which keeps it privately. The page sends only what the
// user writes; no details of the phone or the wallet.

export type ReportKind = 'problem' | 'idea' | 'security';

const REPO = 'https://github.com/mbdrivechains/freebank-app';

/** The GitHub page for a report: the Problem or Idea form, or the private security report. */
export function githubUrl(kind: ReportKind): string {
  if (kind === 'security') return `${REPO}/security/advisories/new`;
  return `${REPO}/issues/new?template=${kind === 'idea' ? 'idea' : 'problem'}.yml`;
}

/** Invisible characters the relay refuses (relay/src/feedback.rs `invisible`). */
const INVISIBLE: [number, number][] = [
  [0x061c, 0x061c], [0x200e, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069], [0x00ad, 0x00ad], [0x034f, 0x034f],
  [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200d], [0x2060, 0x2065], [0x206a, 0x206f],
  [0x2028, 0x2029], [0x3164, 0x3164], [0xe000, 0xf8ff], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0],
  [0xfff9, 0xfffb], [0x1d173, 0x1d17a], [0xe0000, 0xeffff], [0xf0000, 0x10ffff],
];

/** Text as the relay takes it: new lines as \n, no other control characters, nothing invisible. */
export function clean(s: string, multiline: boolean): string {
  return Array.from(s.replace(/\r\n?/g, '\n'))
    .filter((c) => {
      const n = c.codePointAt(0)!;
      const control = n < 0x20 || (n >= 0x7f && n <= 0x9f);
      const invisible = INVISIBLE.some(([a, b]) => n >= a && n <= b);
      return !((control && !(multiline && (c === '\n' || c === '\t'))) || invisible);
    })
    .join('');
}

/** The server takes 64 KiB in all: the text up to 8,000 characters (which some scripts make 14,000 bytes or more),
 *  and the recent activity, at most 60 short lines here, up to 40,000. */
const MAX_TEXT_BYTES = 14_000;

/** Post a report; its reference, or throws with a message for the user. */
export async function sendReport(kind: ReportKind, text: string, contact: string, activity = ''): Promise<string> {
  if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES) throw new Error('That is longer than FreeBank takes; shorten it, please.');
  let res: Response;
  try {
    res = await fetch('/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind,
        text: clean(text.trim(), true),
        contact: clean(contact.trim(), false),
        ...(activity ? { activity: clean(activity, true) } : {}),
        from: 'phone',
      }),
    });
  } catch {
    throw new Error("FreeBank's server couldn't be reached. Check your connection, or use GitHub.");
  }
  const reply = await res.json().catch(() => ({}));
  if (res.ok) return String(reply.id ?? '').replace(/[^0-9a-f]/g, '').slice(0, 16);
  const why = typeof reply.error === 'string' ? reply.error.slice(0, 200) : '';
  throw new Error(why ? `FreeBank's server didn't take the report: ${why}.` : `FreeBank's server didn't take the report (${res.status}).`);
}
