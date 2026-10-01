import './app.css';
import App from './App.svelte';
import { takePairFragment } from './lib/fragment';

// Take the pairing fragment and remove it from the address bar before anything else runs,
// so the one-time code does not linger in history, bookmarks or screenshots.
const pairValue = takePairFragment();

const app = new App({ target: document.getElementById('app')!, props: { pairValue } });
export default app;
