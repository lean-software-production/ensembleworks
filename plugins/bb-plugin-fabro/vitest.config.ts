import { defineConfig, configDefaults } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: { exclude: [...configDefaults.exclude, "skills/**/*.test.mjs"], environment: "node", maxWorkers: 3, testTimeout: 15_000 },
});
