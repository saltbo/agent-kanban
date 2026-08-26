#!/usr/bin/env bash
set -euo pipefail

# Synchronize shared skill reference documents into each installable skill.
#
# Why generated targets have no file header:
# The target files are bundled into user-installed skills. A "generated file"
# banner would leak repository-maintenance details into the user/runtime
# environment and waste skill context. Keep generation metadata here instead.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

REFERENCES=(
  "leader-verification.md"
  "runtime-delegation.md"
  "specialist-profiles.md"
  "wait-monitoring.md"
)

mode="${1:-sync}"

if [[ "$mode" != "sync" && "$mode" != "--check" ]]; then
  echo "Usage: scripts/sync-skill-references.sh [--check]" >&2
  exit 2
fi

for reference in "${REFERENCES[@]}"; do
  source="$ROOT/skills/_shared/$reference"
  targets=(
    "$ROOT/skills/ak-plan/references/$reference"
    "$ROOT/skills/ak-task/references/$reference"
  )

  for target in "${targets[@]}"; do
    if [[ "$mode" == "--check" ]]; then
      if ! cmp -s "$source" "$target"; then
        echo "Out of sync: ${target#$ROOT/}" >&2
        echo "Run: scripts/sync-skill-references.sh" >&2
        exit 1
      fi
    else
      mkdir -p "$(dirname "$target")"
      cp "$source" "$target"
    fi
  done
done
