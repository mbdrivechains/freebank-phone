import './app.css';
import App from './App.svelte';
import { takePairFragment } from './lib/fragment';
import { note } from './lib/activity';

// Take the pairing fragment and remove it from the address bar before anything else runs,
// so the one-time code does not linger in history, bookmarks or screenshots.
const pairValue = takePairFragment();

// Errors the page didn't catch, for "Include recent activity" (lib/activity.ts).
window.addEventListener('error', (e) => note(`page error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => note(`page error: ${(e.reason as Error)?.message ?? e.reason}`));

const app = new App({ target: document.getElementById('app')!, props: { pairValue } });
export default app;
