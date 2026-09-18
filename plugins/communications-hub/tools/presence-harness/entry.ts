// Browser-validation entry point. Bundled by vite so a real Chromium can mount
// the REAL strip module against a faithful copy of bb's sidebar DOM and be
// MEASURED — jsdom has no layout engine, so row height, clipping, scroll
// preservation and popover geometry cannot be checked there at all.
import { mountPresenceStrip } from "../../src/presence/ui/mount.js";

declare global {
  interface Window {
    __presence: { mount: typeof mountPresenceStrip };
  }
}

window.__presence = { mount: mountPresenceStrip };
