/**
 * Which files each guidance sweep is responsible for. Used two ways:
 * against the emitted baseline, to confirm neither sweep has a blind spot
 * in `templates/core` before reporting a clean run (unit-tested directly
 * against the real tree in `tests/domain-map.test.ts`, so a new template
 * file added later can't silently fall outside both domains without a test
 * noticing); and in adopt mode, to classify a real pre-existing project's
 * files, which is why the glob lists also cover common non-baseline
 * equivalents (`.eslintrc.*`, `jest.config.*`, `.husky/**`, ...) alongside
 * the baseline's own exact filenames.
 */

/** Simple glob support: `**` matches any sequence (including `/`), `*` matches within a segment. */
function globToRegExp(pattern: string): RegExp {
  const escapeLiteral = (segment: string): string =>
    segment.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = pattern
    .split("**")
    .map((part) => part.split("*").map(escapeLiteral).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

export function matchesAnyGlob(
  path: string,
  globs: readonly string[],
): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/** Every TypeScript-facing file `typescript-guidance` is responsible for. */
export const TYPESCRIPT_DOMAIN_GLOBS = [
  "tsconfig*.json",
  "**/tsconfig*.json",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.ts",
  ".eslintrc.*",
  "vitest.config.ts",
  "vitest.config.js",
  "jest.config.*",
  "package.json",
  "knip.json",
  "lefthook.yml",
  "lefthook.yaml",
  ".husky/**",
  "simple-git-hooks.json",
  "pnpm-workspace.yaml",
  "turbo.json",
  "nx.json",
  "lerna.json",
  "commitlint.config.js",
  ".node-version",
  ".nvmrc",
  ".prettierrc.json",
  ".prettierignore",
  "biome.json",
  "bin/*.mjs",
  "bin/*.json",
  "bin/lib/*.mjs",
  "bin/lib/*.json",
  ".github/workflows/*.yml",
  "docs/research/typescript-refresh.md",
  "src/**",
  "tests/**",
] as const;

/**
 * Harness-grader files that live under `bin/`. `bin/*.mjs` and
 * `bin/lib/*.mjs` are typescript-domain globs, so without this list the
 * grader's own rules would be swept by `typescript-guidance` -- wrong,
 * because they encode Claude Code harness guidance. The Claude Code Action
 * workflow is here for the same reason against `.github/workflows/*.yml`:
 * its trigger, action pin and model limits are Anthropic guidance, not
 * toolchain. Consulted before the typescript list in `classifyPath`.
 */
export const HARNESS_OVERRIDE_GLOBS = [
  "bin/check-harness.mjs",
  "bin/lib/harness-rules.mjs",
  "bin/lib/frontmatter.mjs",
  ".github/workflows/claude.yml",
] as const;

/** Every `.claude/`-facing file `harness-guidance` is responsible for. */
export const HARNESS_DOMAIN_GLOBS = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude/hooks/*.mjs",
  ".claude/hooks/*.js",
  ".claude/agents/*.md",
  ".claude/skills/**",
  ".claude/rules/*.md",
  ".claude/commands/**",
  ".claude-plugin/**",
  ".mcp.json",
  "CLAUDE.md",
  "docs/research/harness-refresh.md",
] as const;

/** Files neither sweep governs by design -- not a gap, an explicit exclusion. */
export const NEUTRAL_GLOBS = [
  "README.md",
  ".gitignore",
  ".npmrc",
  ".gitattributes",
] as const;

export type DomainClassification =
  "typescript" | "harness" | "neutral" | "uncovered";

/**
 * Classifies one emitted-project-relative path (POSIX-separated) into a
 * domain. `extraGlobs` lets a caller (adopt mode's inventory, for a project
 * with unconventional paths) extend classification for one call without
 * mutating the shared glob lists -- each entry pairs a domain with its own
 * extra patterns.
 */
export function classifyPath(
  path: string,
  extraGlobs?: {
    typescript?: readonly string[];
    harness?: readonly string[];
  },
): DomainClassification {
  if (matchesAnyGlob(path, HARNESS_OVERRIDE_GLOBS)) return "harness";
  if (matchesAnyGlob(path, TYPESCRIPT_DOMAIN_GLOBS)) return "typescript";
  if (matchesAnyGlob(path, HARNESS_DOMAIN_GLOBS)) return "harness";
  if (matchesAnyGlob(path, NEUTRAL_GLOBS)) return "neutral";
  // extraGlobs is consulted last -- it extends classification for paths the
  // shared lists don't cover, never overrides an explicit domain or neutral
  // verdict the shared lists already reached.
  if (extraGlobs?.typescript && matchesAnyGlob(path, extraGlobs.typescript))
    return "typescript";
  if (extraGlobs?.harness && matchesAnyGlob(path, extraGlobs.harness))
    return "harness";
  return "uncovered";
}
