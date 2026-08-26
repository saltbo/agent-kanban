import { readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "tsup";

const pkgVersion = (JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf-8")) as { version: string }).version;

const SDK_STUB = path.resolve(__dirname, "src/providers/sdkStub.ts");
const KEYRING_STUB = path.resolve(__dirname, "src/keyringStub.ts");
// Local provider runtime SDKs: heavy, native-adjacent, and useless inside a
// cloud sandbox. The standalone bundle replaces them with throwing stubs.
const PROVIDER_SDKS = ["@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk", "@github/copilot-sdk", "@agentclientprotocol/sdk"];

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: "esm",
    target: "node22",
    outDir: "dist",
    clean: true,
    splitting: false,
    banner: { js: "#!/usr/bin/env node" },
    noExternal: ["@agent-kanban/shared"],
    // The provider SDKs moved to devDependencies (npm consumers don't install
    // them), so tsup would bundle them by default — keep them external; the
    // providers load them lazily and fail gracefully when absent.
    external: [...PROVIDER_SDKS, "@napi-rs/keyring"],
  },
  // Fully self-contained build for environments without npm (AMA cloud
  // sandboxes fetch this single file from the AK server and run it with node).
  {
    entry: { standalone: "src/index.ts" },
    format: "esm",
    target: "node22",
    outDir: "dist",
    clean: false,
    splitting: false,
    banner: {
      js: '#!/usr/bin/env node\nimport { createRequire as __akCreateRequire } from "node:module"; const require = __akCreateRequire(import.meta.url);',
    },
    noExternal: [/.*/],
    define: { __AK_VERSION__: JSON.stringify(pkgVersion) },
    esbuildOptions(options) {
      options.alias = {
        ...Object.fromEntries(PROVIDER_SDKS.map((pkg) => [pkg, SDK_STUB])),
        "@napi-rs/keyring": KEYRING_STUB,
      };
    },
  },
]);
