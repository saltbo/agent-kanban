import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/v2/**/*.test.ts", "tests/v2/**/*.test.tsx"],
    exclude: ["tests-v1/**", "**/*-v1/**"],
    coverage: {
      provider: "v8",
      include: ["apps/web/server/**/*.ts", "apps/web/worker/**/*.ts", "apps/web/src/**/*.{ts,tsx}"],
      exclude: ["**/*.d.ts", "**/types.ts", "apps/web/src/main.tsx"],
      reporter: ["text", "json", "html"],
    },
    server: {
      deps: {
        inline: ["hono", "jose", "miniflare"],
      },
    },
  },
});
