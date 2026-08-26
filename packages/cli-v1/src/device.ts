import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { dirname } from "node:path";
import { MACHINE_ID_FILE } from "./paths.js";

export function generateDeviceId(machineIdFile = MACHINE_ID_FILE): string {
  const stored = readMachineId(machineIdFile);
  if (stored) return stored;

  const id = legacyDeviceId();
  mkdirSync(dirname(machineIdFile), { recursive: true });
  writeFileSync(machineIdFile, `${id}\n`);
  return id;
}

function readMachineId(machineIdFile: string): string | null {
  try {
    const id = readFileSync(machineIdFile, "utf-8").trim();
    return id || null;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

function legacyDeviceId(): string {
  const host = hostname();
  const nets = networkInterfaces();
  let mac = "";
  for (const ifaces of Object.values(nets)) {
    const found = ifaces?.find((i) => !i.internal && i.mac !== "00:00:00:00:00:00");
    if (found) {
      mac = found.mac;
      break;
    }
  }
  return createHash("sha256").update(`${host}:${mac}`).digest("hex").slice(0, 16);
}
