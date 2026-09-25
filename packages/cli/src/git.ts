/**
 * The two mechanical steps fresh mode runs after emission -- writing the
 * baseline template tree into the target directory (`emitTemplate` in
 * `emit.ts`, called from `main.ts`'s `runFresh`). `gitInit` initializes a
 * fresh git repository there (`git init -q`); `runInstall` then runs the
 * first package install (`pnpm install`). Both run synchronously in the
 * target directory with the child's output passed straight through.
 */
import { execFileSync } from "node:child_process";

export function gitInit(cwd: string): void {
  execFileSync("git", ["init", "-q"], { cwd, stdio: "inherit" });
}

export function runInstall(cwd: string): void {
  execFileSync("pnpm", ["install"], { cwd, stdio: "inherit" });
}
