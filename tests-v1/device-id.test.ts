import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateDeviceId } from "../packages/cli/src/device";

const dirs: string[] = [];

function tempMachineIdFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "ak-device-id-"));
  dirs.push(dir);
  return join(dir, "machine-id");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("generateDeviceId", () => {
  it("reuses the persisted machine id", () => {
    const file = tempMachineIdFile();
    writeFileSync(file, "stable-machine-id\n");

    expect(generateDeviceId(file)).toBe("stable-machine-id");
  });

  it("persists the initial machine id", () => {
    const file = tempMachineIdFile();

    const id = generateDeviceId(file);

    expect(readFileSync(file, "utf-8").trim()).toBe(id);
    expect(generateDeviceId(file)).toBe(id);
  });
});
