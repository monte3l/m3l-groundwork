---
"@monte3l/groundwork": patch
---

A pack can now declare `setupSteps` in its `pack.json`: the exact commands a user must run in the new project before the first `pnpm verify`. Fresh mode prints them in one block after the `ready` line (and also before the error when `git init` or `pnpm install` fails after the project is written), so `--pack publishing` no longer ends in a green "ready" followed by a red first verify with no hint why. The `publishing` pack declares `pnpm add -D @changesets/cli`, `git add -A`, `node bin/check-license-headers.mjs --fix` and `git add -A`: the license-header gate only checks git-tracked files, so without staging first `--fix` fixes nothing and the gate trivially passes until the first commit. `loadPack` rejects a `setupSteps` that is not a non-empty array of single-line, non-empty strings. Adopt mode and the inventory are unchanged.
