// Ask FreeBank on the phone (phone page v0.4.6, as the desktop app's ?): a question to FreeBank's AI helper, which
// answers from FreeBank's notes only and can't act. It goes to one fixed address (the relay's CSP allows it and
// nothing else beyond this site), as text/plain, so no preflight; nothing about the phone or the wallet goes with it.
// A question that looks like recovery words is refused here and never sent (the helper refuses them too).
import { wordlist } from '@scure/bip39/wordlists/english.js';

export const ASK_URL = 'https://ask.ecxfreebank.com/ask';
export const MAX_QUESTION = 500;
/** The most of an answer read. */
const MAX_BODY = 64 * 1024;
const WORDS = new Set(wordlist);
const PREFIXES = new Set(wordlist.map((w) => w.slice(0, 4)));

/** Twelve or more recovery-list words within any 15 in a row (as the desktop's ask.rs): a word counts by its first
 *  four letters too, as BIP39 words are unique by them and people shorten them. */
export function looksLikeWords(q: string): boolean {
  const hit = q
    .split(/[^A-Za-z]+/)
    .filter((t) => t)
    .map((t) => {
      const w = t.toLowerCase();
      return WORDS.has(w) || (w.length === 4 && PREFIXES.has(w));
    });
  const n = Math.max(1, Math.min(15, hit.length));
  for (let i = 0; i + n <= hit.length; i++) {
    if (hit.slice(i, i + n).filter(Boolean).length >= 12) return true;
  }
  return false;
}

/** What to send, or throws with why not. */
export function check(question: string): string {
  const q = question.trim();
  if (!q) throw new Error('Ask a question.');
  if (Array.from(q).length > MAX_QUESTION) throw new Error(`Please keep it under ${MAX_QUESTION} characters.`);
  if (looksLikeWords(q)) {
    throw new Error(
      'That looks like recovery words. Never type them anywhere, here included: anyone who has them can take your ' +
        'coins. Nothing was sent.',
    );
  }
  return q;
}

/** The helper's answer, or throws with a message for the user. */
export async function askHelper(question: string, fetcher: typeof fetch = fetch): Promise<string> {
  const q = check(question);
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 50_000);
  let body: string;
  try {
    const res = await fetcher(ASK_URL, {
      method: 'POST',
      body: JSON.stringify({ q }),
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: stop.signal,
    });
    body = await res.text();
  } catch {
    throw new Error("FreeBank's helper isn't answering just now. Check your connection, or try again in a minute.");
  } finally {
    clearTimeout(timer);
  }
  if (body.length > MAX_BODY) throw new Error("FreeBank's helper gave an answer FreeBank couldn't read.");
  let reply: { answer?: unknown; error?: unknown };
  try {
    reply = JSON.parse(body);
  } catch {
    throw new Error("FreeBank's helper gave an answer FreeBank couldn't read.");
  }
  if (typeof reply.answer === 'string') return Array.from(reply.answer).slice(0, 4000).join('');
  throw new Error(
    typeof reply.error === 'string' ? Array.from(reply.error).slice(0, 400).join('') : "FreeBank's helper couldn't answer just now.",
  );
}
