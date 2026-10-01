/** Read `#pair=…` and strip it from the address bar at once. Null when there is none. */
export function takePairFragment(): string | null {
  if (!location.hash.startsWith('#pair=')) return null;
  const v = location.hash.slice('#pair='.length);
  history.replaceState(history.state, '', location.pathname + location.search);
  return v || null;
}
