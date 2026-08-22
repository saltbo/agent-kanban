import { platform } from "node:os";
import { resolveExecutable } from "../executable.js";
import { getAvailableProviders } from "../providers/registry.js";

interface BinaryDep {
  command: string;
  purpose: string;
  hints: { darwin?: string; linux?: string; generic: string };
}

const REQUIRED_BINARIES: BinaryDep[] = [
  {
    command: "git",
    purpose: "repository clone, worktree, and branch operations",
    hints: {
      darwin: "brew install git",
      linux: "apt install git  |  dnf install git",
      generic: "https://git-scm.com/downloads",
    },
  },
  {
    command: "gh",
    purpose: "repository cloning and PR status checks",
    hints: {
      darwin: "brew install gh",
      linux: "apt install gh  |  dnf install gh",
      generic: "https://cli.github.com/",
    },
  },
  {
    command: "npx",
    purpose: "installing agent skills into worktrees",
    hints: {
      darwin: "brew install node  (or: volta install node)",
      linux: "install Node.js — https://nodejs.org/",
      generic: "https://nodejs.org/",
    },
  },
];

function isOnPath(command: string): boolean {
  return resolveExecutable(command) !== null;
}

function hintFor(dep: BinaryDep): string {
  const plat = platform();
  if (plat === "darwin" && dep.hints.darwin) return dep.hints.darwin;
  if (plat === "linux" && dep.hints.linux) return dep.hints.linux;
  return dep.hints.generic;
}

export function checkDaemonDependencies(): string[] {
  const errors: string[] = [];

  for (const dep of REQUIRED_BINARIES) {
    if (!isOnPath(dep.command)) {
      errors.push(`  • \`${dep.command}\` — ${dep.purpose}\n    Install: ${hintFor(dep)}`);
    }
  }

  if (getAvailableProviders().length === 0) {
    errors.push(
      "  • no agent runtime on PATH — need at least one of: claude, codex, gemini, copilot, hermes\n" +
        "    Install e.g. `npm install -g @anthropic-ai/claude-code`  or  `volta install @anthropic-ai/claude-code`",
    );
  }

  return errors;
}

export function assertDaemonDependencies(): void {
  const errors = checkDaemonDependencies();
  if (errors.length === 0) return;

  console.error("Cannot start daemon — missing required dependencies:\n");
  console.error(errors.join("\n\n"));
  console.error("");
  process.exit(1);
}
