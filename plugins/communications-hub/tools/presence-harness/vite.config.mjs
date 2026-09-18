import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

/** Bundles the real strip module for a real browser. Output is git-ignored. */
export default defineConfig({
  build: {
    lib: {
      entry: fileURLToPath(new URL("./entry.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "presence-harness.js",
    },
    outDir: fileURLToPath(new URL("../../dist/presence-harness", import.meta.url)),
    emptyOutDir: true,
    minify: false,
  },
});
