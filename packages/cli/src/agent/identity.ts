import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCredentials } from "../config.js";
import { generateDeviceId } from "../device.js";
import { IDENTITIES_DIR } from "../paths.js";

export interface StoredIdentity {
  agent_id: string;
  name: string;
  fingerprint: string;
}

function identityPath(runtime: string): string {
  const { apiUrl } = getCredentials();
  const scope = createHash("sha256").update(`${apiUrl}\n${generateDeviceId()}\n${runtime}`).digest("hex").slice(0, 16);
  return join(IDENTITIES_DIR, `${runtime}-${scope}.json`);
}

export function loadIdentity(runtime: string): StoredIdentity | null {
  try {
    return JSON.parse(readFileSync(identityPath(runtime), "utf-8"));
  } catch {
    return null;
  }
}

export function saveIdentity(runtime: string, identity: StoredIdentity): void {
  mkdirSync(IDENTITIES_DIR, { recursive: true });
  writeFileSync(identityPath(runtime), `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
}

export function removeIdentity(runtime: string): boolean {
  try {
    rmSync(identityPath(runtime));
    return true;
  } catch {
    return false;
  }
}
