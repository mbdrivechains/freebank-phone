// sECX display and input. sECX only: never grams or gold.

/** 12.5 -> "12.50", 0.00012 -> "0.00012", at most 8 decimals. */
export function fmtEcx(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const neg = n < 0;
  let s = Math.abs(n).toFixed(8).replace(/0+$/, '');
  const [i, f = ''] = s.split('.');
  s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + f.padEnd(2, '0');
  return (neg ? '-' : '') + s;
}

/** Parse what the user typed. Accepts "0.05", ".05", "0,05" (comma keypads). null if invalid. */
export function parseAmount(input: string): number | null {
  const s = input.trim().replace(',', '.');
  if (!/^(\d+(\.\d{0,8})?|\.\d{1,8})$/.test(s)) return null;
  const n = Number(s);
  return n > 0 && Number.isFinite(n) ? Math.round(n * 1e8) / 1e8 : null;
}

export function fmtTime(unix: number): string {
  if (!unix) return '';
  const d = new Date(unix * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

export function categoryLabel(c: string, amount: number): string {
  switch (c) {
    case 'receive': return 'Received';
    case 'send': return 'Sent';
    case 'generate': return 'Mined';
    case 'immature': return 'Mined (maturing)';
    default: return amount < 0 ? 'Sent' : 'Received';
  }
}

export function shortId(s: string, n = 8): string {
  return s.length > n * 2 + 1 ? s.slice(0, n) + '…' + s.slice(-n) : s;
}

export function defaultDeviceName(ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string {
  if (/Android/i.test(ua)) return 'Android phone';
  if (/iPad/i.test(ua)) return 'iPad';
  return 'iPhone';
}
