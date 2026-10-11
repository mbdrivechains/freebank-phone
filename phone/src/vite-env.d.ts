/// <reference types="svelte" />
/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The token wallet's mint (https://…), set when the page is built; empty: tokens are off. */
  readonly VITE_FB_MINT?: string;
}
