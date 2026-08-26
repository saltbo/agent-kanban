import { execFileSync } from "node:child_process";
import { hostname, platform } from "node:os";

export function resolveMachineName(): string {
  if (platform() !== "darwin") return hostname();

  const localHostName = execFileSync("scutil", ["--get", "LocalHostName"], { encoding: "utf-8" }).trim();
  return `${localHostName}.local`;
}
