// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Shared loader for the `guard-readonly-bash.mjs` pack hook. The hook imports
 * `../../bin/lib/agent-roster.mjs`, which only exists in an emitted project,
 * so each call copies the hook and the roster into a fresh temp directory
 * mirroring that layout (`.claude/hooks/` + `bin/lib/`) and imports it from
 * there with a cache-busting URL.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  type PathLike,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const hookSource = join(
  repoRoot,
  "templates/packs/harness-extras/files/.claude/hooks/guard-readonly-bash.mjs",
);
const rosterSource = join(repoRoot, "templates/core/bin/lib/agent-roster.mjs");

export interface GuardVerdict {
  blocked: boolean;
  reason?: string;
}

export interface HookRun {
  status: number | null;
  stderr: string;
}

export interface LoadedGuard {
  classify: (command: string) => GuardVerdict;
  /** Spawns the copied hook as a real process, feeding `payload` on stdin. */
  runHook: (payload: unknown) => HookRun;
  cleanup: () => void;
}

interface GuardModule {
  classifyBashCommand: (command: string) => GuardVerdict;
}

/** Loads the pack hook from a temp mirror of an emitted project. */
export async function loadGuard(): Promise<LoadedGuard> {
  const scratch: PathLike = mkdtempSync(join(tmpdir(), "guard-readonly-bash-"));
  mkdirSync(join(scratch, ".claude", "hooks"), { recursive: true });
  mkdirSync(join(scratch, "bin", "lib"), { recursive: true });
  const hookCopy = join(scratch, ".claude", "hooks", "guard-readonly-bash.mjs");
  copyFileSync(hookSource, hookCopy);
  copyFileSync(rosterSource, join(scratch, "bin", "lib", "agent-roster.mjs"));
  mkdirSync(join(scratch, ".claude", "agents"), { recursive: true });
  writeFileSync(
    join(scratch, ".claude", "agents", "code-reviewer.md"),
    "---\nname: code-reviewer\n---\nReview only.\n",
  );
  const url = `${pathToFileURL(hookCopy).href}?v=${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
  const mod = (await import(url)) as GuardModule;
  return {
    classify: (command) => mod.classifyBashCommand(command),
    runHook: (payload) => {
      const result = spawnSync(process.execPath, [hookCopy], {
        input: JSON.stringify(payload),
        encoding: "utf8",
      });
      return { status: result.status, stderr: result.stderr };
    },
    cleanup: () => {
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}
