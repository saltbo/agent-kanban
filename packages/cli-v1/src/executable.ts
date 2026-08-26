import { accessSync, constants, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";

function isExecutable(path: string): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const hasPath = isAbsolute(command) || command.includes("/") || command.includes("\\");
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const pathExtValue = env.PATHEXT ?? env.PathExt ?? env.Pathext ?? ".COM;.EXE;.BAT;.CMD";
  const directories = hasPath
    ? [""]
    : pathValue
        .split(delimiter)
        .map((entry) => entry.replace(/^"|"$/g, ""))
        .filter(Boolean);
  const extensions =
    process.platform === "win32" && !extname(command)
      ? pathExtValue
          .split(";")
          .map((extension) => extension.toLowerCase())
          .filter(Boolean)
      : [""];

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = directory ? join(directory, `${command}${extension}`) : `${command}${extension}`;
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}
