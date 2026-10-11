/** Read `#pair=…` and strip it from the address bar at once. Null when there is none. */
export function takePairFragment(): string | null {
  return take('#pair=');
}

/** Read `#pay=…` (a payment link, desktop v0.2.8) and strip it from the address bar at once. Null when there is none. */
export function takePayFragment(): string | null {
  return take('#pay=');
}

/** Read `#token=…` (a token link) and strip it from the address bar at once: the link carries money. */
export function takeTokenFragment(): string | null {
  return take('#token=');
}

function take(prefix: string): string | null {
  if (!location.hash.startsWith(prefix)) return null;
  const v = location.hash.slice(prefix.length);
  history.replaceState(history.state, '', location.pathname + location.search);
  return v || null;
}
