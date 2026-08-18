import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CONFIG_FILE } from "./paths.js";

interface Credential {
  "api-url": string;
  "api-key": string;
}

interface Config {
  current?: string;
  credentials: Record<string, Credential>;
}

function hostFromUrl(url: string): string {
  return new URL(url).host;
}

function migrate(raw: Record<string, any>): Config {
  if (raw["api-url"] && raw["api-key"]) {
    const host = hostFromUrl(raw["api-url"]);
    const config: Config = {
      current: host,
      credentials: {
        [host]: { "api-url": raw["api-url"], "api-key": raw["api-key"] },
      },
    };
    writeConfig(config);
    return config;
  }
  return { credentials: {} };
}

export function readConfig(): Config {
  protectConfigPermissions();
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    // Detect legacy format: has top-level api-url instead of credentials
    if (raw["api-url"] && !raw.credentials) {
      return migrate(raw);
    }
    return { credentials: {}, ...raw };
  } catch {
    return { credentials: {} };
  }
}

export function writeConfig(config: Config): void {
  protectConfigPermissions();
  writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(CONFIG_FILE, 0o600);
}

function protectConfigPermissions(): void {
  const configDir = dirname(CONFIG_FILE);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  chmodSync(configDir, 0o700);
  if (existsSync(CONFIG_FILE)) chmodSync(CONFIG_FILE, 0o600);
}

export function getCredentials(host?: string): { apiUrl: string; apiKey: string } {
  const config = readConfig();
  const target = host || config.current;
  if (!target) throw new Error("No AK API environment configured. Run: ak config set --api-url <url> --api-key <key>");
  const cred = config.credentials[target];
  if (!cred) throw new Error(`No AK API credentials for ${target}. Run: ak config set --api-url <url> --api-key <key>`);
  return { apiUrl: cred["api-url"], apiKey: cred["api-key"] };
}

export function saveCredentials(apiUrl: string, apiKey: string): void {
  const host = hostFromUrl(apiUrl);
  const config = readConfig();
  config.credentials[host] = { "api-url": apiUrl, "api-key": apiKey };
  config.current = host;
  writeConfig(config);
}

export function updateCredentials(apiUrl: string, updates: Partial<Credential>): void {
  const host = hostFromUrl(apiUrl);
  const config = readConfig();
  const existing = config.credentials[host];
  if (!existing) throw new Error(`No credentials for ${host}`);
  config.credentials[host] = { ...existing, ...updates };
  writeConfig(config);
}

export function setCurrent(apiUrl: string): void {
  const host = hostFromUrl(apiUrl);
  const config = readConfig();
  if (!config.credentials[host]) throw new Error(`No credentials for ${host}`);
  config.current = host;
  writeConfig(config);
}

// Backward-compatible helpers used by other modules during transition
export function getConfigValue(key: "api-url" | "api-key"): string | undefined {
  try {
    const { apiUrl, apiKey } = getCredentials();
    return key === "api-url" ? apiUrl : apiKey;
  } catch {
    return undefined;
  }
}
