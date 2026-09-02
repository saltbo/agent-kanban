import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "shared"),
      "@server": path.resolve(__dirname, "server"),
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: "unit-domain",
          environment: "node",
          include: ["tests/unit/domain/**/*.test.{ts,tsx}"],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "unit-application",
          environment: "node",
          include: ["tests/unit/application/**/*.test.{ts,tsx}"],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "unit-component",
          environment: "jsdom",
          include: ["tests/unit/component/**/*.test.{ts,tsx}"],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "integration-adapters",
          environment: "node",
          include: ["tests/integration/adapters/**/*.test.{ts,tsx}"],
          sequence: { groupOrder: 1 },
          pool: "forks",
          maxWorkers: 1,
        },
      },
      {
        extends: true,
        test: {
          name: "integration-migrations",
          environment: "node",
          include: ["tests/integration/migrations/**/*.test.{ts,tsx}"],
          sequence: { groupOrder: 2 },
          pool: "forks",
          maxWorkers: 1,
        },
      },
      {
        extends: true,
        test: {
          name: "integration-http",
          environment: "node",
          include: ["tests/integration/http/**/*.test.{ts,tsx}"],
          sequence: { groupOrder: 3 },
          pool: "forks",
          maxWorkers: 1,
        },
      },
      {
        extends: true,
        test: {
          name: "contract-http",
          environment: "node",
          include: ["tests/contract/http/**/*.test.{ts,tsx}"],
          sequence: { groupOrder: 4 },
          pool: "forks",
          maxWorkers: 1,
        },
      },
      {
        extends: true,
        test: {
          name: "legacy",
          environment: "jsdom",
          include: ["tests/**/*.test.{ts,tsx}"],
          exclude: ["tests/unit/**", "tests/integration/**", "tests/contract/**", "tests/acceptance/**", "tests/e2e/**"],
          sequence: { groupOrder: 5 },
          pool: "forks",
          maxWorkers: 1,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["server/**/*.ts", "shared/**/*.ts"],
      exclude: ["**/*.d.ts", "**/types.ts"],
    },
    server: {
      deps: {
        inline: ["jose", "miniflare"],
      },
    },
  },
});
