import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface WindowsProcessInfo {
  pid: number;
  ppid: number;
  executable: string | null;
  commandLine: string | null;
}

interface ProcessTreeAddon {
  getProcessAncestry(startPid: number, maxDepth: number): WindowsProcessInfo[];
}

export function getWindowsProcessAncestry(startPid: number, maxDepth = 32): WindowsProcessInfo[] {
  const addonPath = join(dirname(fileURLToPath(import.meta.url)), "native", "win32-x64", "process-tree.node");
  let addon: ProcessTreeAddon;
  try {
    addon = createRequire(import.meta.url)(addonPath) as ProcessTreeAddon;
  } catch (error) {
    throw new Error(`AK Windows process-tree addon could not be loaded from ${addonPath}`, { cause: error });
  }
  return addon.getProcessAncestry(startPid, maxDepth);
}
