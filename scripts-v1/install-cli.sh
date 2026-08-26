#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== Building ==="
cd "$ROOT"
pnpm --filter @agent-kanban/shared build
pnpm --filter agent-kanban build

echo "=== Publishing standalone bundle to web assets ==="
mkdir -p "$ROOT/apps/web/public/cli"
cp "$ROOT/packages/cli/dist/standalone.js" "$ROOT/apps/web/public/cli/ak-standalone.mjs"

echo "=== Linking ==="
cd "$ROOT/packages/cli"
npm link

echo ""
echo "Done! Commands available: ak, agent-kanban"
ak --version
