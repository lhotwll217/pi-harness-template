import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Vite does not read tsconfig `paths`, so the `@/` alias the app is written in has to be
// restated here for tests that import components and route handlers. `server-only` is Next's
// build-time guard and resolves only inside Next, so tests load an empty module for it.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./src/test/server-only.ts", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
    restoreMocks: true,
  },
});
