/** The two mechanical steps after emission: `git init`, then the first install. */
import { execFileSync } from "node:child_process";

export function gitInit(cwd: string): void {
  execFileSync("git", ["init", "-q"], { cwd, stdio: "inherit" });
}

export function runInstall(cwd: string): void {
  execFileSync("pnpm", ["install"], { cwd, stdio: "inherit" });
}
