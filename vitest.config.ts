import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);

export default defineConfig({
  resolve: {
    alias: {
      "@agent-kanban/shared": path.resolve(__dirname, "packages/shared/src"),
      "@": path.resolve(__dirname, "apps/web/src"),
      // Frontend deps not hoisted to root — resolve from web app
      react: path.resolve(__dirname, "apps/web/node_modules/react"),
      "react-dom": path.resolve(__dirname, "apps/web/node_modules/react-dom"),
      "react/jsx-runtime": path.resolve(__dirname, "apps/web/node_modules/react/jsx-runtime"),
      "react-router-dom": require.resolve("react-router-dom"),
      dompurify: require.resolve("dompurify"),
      "lucide-react": path.resolve(__dirname, "apps/web/node_modules/lucide-react"),
      "@base-ui/react": path.resolve(__dirname, "apps/web/node_modules/@base-ui/react"),
      "@assistant-ui/react": path.resolve(__dirname, "apps/web/node_modules/@assistant-ui/react"),
      "@tanstack/react-query": path.resolve(__dirname, "apps/web/node_modules/@tanstack/react-query"),
      "prism-react-renderer": path.resolve(__dirname, "apps/web/node_modules/prism-react-renderer"),
      "react-diff-viewer-continued": path.resolve(__dirname, "apps/web/node_modules/react-diff-viewer-continued"),
      "react-markdown": path.resolve(__dirname, "apps/web/node_modules/react-markdown"),
      "remark-gfm": path.resolve(__dirname, "apps/web/node_modules/remark-gfm"),
      clsx: path.resolve(__dirname, "apps/web/node_modules/clsx"),
      "tailwind-merge": path.resolve(__dirname, "apps/web/node_modules/tailwind-merge"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    include: ["**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["apps/web/server/**/*.ts", "packages/shared/src/**/*.ts", "packages/cli/src/**/*.ts"],
      exclude: ["**/*.d.ts", "**/types.ts"],
    },
  },
});
