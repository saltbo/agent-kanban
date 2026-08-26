import { readFileSync } from "node:fs";
import { join } from "node:path";

// Injected by tsup at build time; the standalone bundle has no adjacent
// package.json to read.
declare const __AK_VERSION__: string | undefined;

let cached: string | undefined;

export function getVersion(): string {
  if (cached) return cached;
  if (typeof __AK_VERSION__ === "string") {
    cached = __AK_VERSION__;
    return cached;
  }
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf-8"));
  cached = pkg.version as string;
  return cached;
}
