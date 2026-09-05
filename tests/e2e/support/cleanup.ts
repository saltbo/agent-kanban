import { rm } from "node:fs/promises";

export default async function cleanup() {
  const stateDir = process.env.AK_E2E_STATE_DIR;
  if (!stateDir) throw new Error("Missing isolated E2E state directory");
  await rm(stateDir, { recursive: true, force: true });
}
