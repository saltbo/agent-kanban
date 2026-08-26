import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CONFIG_FILE } from "./paths.js";

export interface RealmrootEnvironment {
  "api-url": string;
  issuer: string;
  resource: string;
  "client-id": string;
}

export interface Config {
  current?: string;
  environments: Record<string, RealmrootEnvironment>;
}

function hostFromUrl(url: string): string {
  return new URL(url).host;
}

export function readConfig(): Config {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Partial<Config> & { credentials?: unknown };
    return { current: raw.current, environments: raw.environments ?? {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Invalid AK configuration at ${CONFIG_FILE}`, { cause: error });
    }
    return { environments: {} };
  }
}

export function writeConfig(config: Config): void {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function getCredentials(host?: string): { apiUrl: string; issuer: string; resource: string; clientId: string } {
  const config = readConfig();
  const target = host || config.current;
  if (!target) throw new Error("No AK environment configured. Run: ak auth login --api-url <url>");
  const environment = config.environments[target];
  if (!environment) throw new Error(`No AK environment for ${target}. Run: ak auth login --api-url <url>`);
  return {
    apiUrl: environment["api-url"],
    issuer: environment.issuer,
    resource: environment.resource,
    clientId: environment["client-id"],
  };
}

export function saveEnvironment(input: { apiUrl: string; issuer: string; resource: string; clientId: string }): void {
  const host = hostFromUrl(input.apiUrl);
  const config = readConfig();
  config.environments[host] = {
    "api-url": input.apiUrl.replace(/\/$/, ""),
    issuer: input.issuer.replace(/\/$/, ""),
    resource: input.resource.replace(/\/$/, ""),
    "client-id": input.clientId,
  };
  config.current = host;
  writeConfig(config);
}

export function setCurrent(apiUrl: string): void {
  const host = hostFromUrl(apiUrl);
  const config = readConfig();
  if (!config.environments[host]) throw new Error(`No Realmroot login for ${host}`);
  config.current = host;
  writeConfig(config);
}
