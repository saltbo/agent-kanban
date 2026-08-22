import { execSync } from "node:child_process";
import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const port = Number(process.env.VITE_DEV_PORT) || 6265;
const origin = `http://localhost:${port}`;
const amaOrigin = process.env.E2E_AMA_ORIGIN ?? "http://127.0.0.1:6266";
const gitSha = execSync("git rev-parse --short HEAD").toString().trim();

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    cloudflare({
      configPath: "../../tests/helpers/wrangler.ak-e2e.jsonc",
      persistState: { path: path.resolve(__dirname, ".wrangler/state") },
      config: (config) => ({
        vars: {
          ...config.vars,
          AK_API_URL: origin,
          AK_RESOURCE: `${origin}/api`,
          ALLOWED_HOSTS: `localhost:${port}`,
          AMA_ORIGIN: amaOrigin,
          AMA_RESOURCE: `${amaOrigin}/api`,
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
      "@agent-kanban/shared": path.resolve(__dirname, "../../packages/shared/src"),
    },
  },
});
