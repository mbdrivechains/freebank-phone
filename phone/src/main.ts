import './app.css';
import App from './App.svelte';
import { takePairFragment, takePayFragment } from './lib/fragment';
import { note } from './lib/activity';

// Take the pairing fragment and remove it from the address bar before anything else runs,
// so the one-time code does not linger in history, bookmarks or screenshots.
const pairValue = takePairFragment();
// A shop's payment link (desktop v0.2.8): taken the same way.
const payValue = pairValue ? null : takePayFragment();

// Errors the page didn't catch, for "Include recent activity" (lib/activity.ts).
window.addEventListener('error', (e) => note(`page error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => note(`page error: ${(e.reason as Error)?.message ?? e.reason}`));

const app = new App({ target: document.getElementById('app')!, props: { pairValue, payValue } });
export default app;
