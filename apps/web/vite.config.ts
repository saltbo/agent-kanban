import { execSync } from "node:child_process";
import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const gitSha = execSync("git rev-parse --short HEAD").toString().trim();

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  server: {
    port: 6265,
    // Cloud smoke runs expose the dev server through a cloudflared quick
    // tunnel so sandbox-hosted agents can call the AK API. A named tunnel
    // (e.g. bodev.agent-kanban.dev) gives a stable dev origin.
    allowedHosts: [".trycloudflare.com", ".agent-kanban.dev"],
  },
  define: {
    __APP_VERSION__: JSON.stringify(gitSha),
  },
  resolve: {
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@agent-kanban/shared": path.resolve(__dirname, "./src/lib/ui-contract.ts"),
    },
  },
});
