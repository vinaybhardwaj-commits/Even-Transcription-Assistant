import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  // `@/…` matches tsconfig paths so lib modules (and their mocks) resolve under vitest.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      // workerd-only package that lives in services/audio-join's own node_modules; see the stub.
      "@cloudflare/containers": fileURLToPath(new URL("./tests/stubs/cloudflare-containers.mjs", import.meta.url)),
    },
  },
  test: { include: ["tests/unit/**/*.test.ts"], environment: "node" },
});
