import { execSync } from "node:child_process";
import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const port = Number(process.env.VITE_DEV_PORT) || 6265;
const origin = `http://localhost:${port}`;
const statePath = process.env.AK_E2E_STATE;
const wranglerConfig = process.env.AK_E2E_WRANGLER_CONFIG;
const gitSha = execSync("git rev-parse --short HEAD").toString().trim();

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    cloudflare({
      configPath: wranglerConfig,
      persistState: statePath ? { path: statePath } : true,
      config: (config) => ({
        vars: {
          ...config.vars,
          AK_API_URL: origin,
          AK_RESOURCE: `${origin}/api`,
          ALLOWED_HOSTS: `localhost:${port}`,
          REALMROOT_SESSION_ENCRYPTION_KEY: "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=",
        },
      }),
    }),
  ],
  server: { port, allowedHosts: ["localhost"] },
  define: { __APP_VERSION__: JSON.stringify(gitSha) },
  resolve: {
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@agent-kanban/shared": path.resolve(__dirname, "./src/lib/ui-contract.ts"),
    },
  },
});
