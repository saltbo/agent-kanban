import { lt } from "semver";

export function isVersionBelowMin(version: string, minVersion: string): boolean {
  return lt(version, minVersion);
}
