import { execSync } from "node:child_process";
import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const port = Number(process.env.VITE_DEV_PORT) || 6265;
const origin = `http://localhost:${port}`;
const gitSha = execSync("git rev-parse --short HEAD").toString().trim();

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    cloudflare({
      configPath: process.env.AK_E2E_WRANGLER_CONFIG ?? "./wrangler.toml",
      persistState: { path: process.env.AK_E2E_STATE_DIR ?? path.resolve(__dirname, ".wrangler/state") },
      config: (config) => ({
        vars: {
          ...config.vars,
          AK_PUBLIC_ORIGIN: origin,
          ALLOWED_HOSTS: `localhost:${port}`,
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
      "@shared": path.resolve(__dirname, "./shared"),
      "@server": path.resolve(__dirname, "./server"),
    },
  },
});
