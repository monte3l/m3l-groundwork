/**
 * Which emitted files each guidance sweep is responsible for. Used by
 * `/customize` to confirm neither sweep has a blind spot in its own domain
 * before reporting a clean run, and unit-tested directly against the real
 * `templates/core` file tree (packages/plugin/tests/domain-map.test.ts) so
 * a new template file added later can't silently fall outside both domains
 * without a test noticing.
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
  "eslint.config.js",
  "vitest.config.ts",
  "package.json",
  "knip.json",
  "lefthook.yml",
  "pnpm-workspace.yaml",
  "commitlint.config.js",
  ".node-version",
  ".prettierrc.json",
  ".prettierignore",
  "bin/*.mjs",
  "bin/lib/*.mjs",
  ".github/workflows/*.yml",
  "docs/research/typescript-refresh.md",
  "src/**",
  "tests/**",
] as const;

/** Every `.claude/`-facing file `harness-guidance` is responsible for. */
export const HARNESS_DOMAIN_GLOBS = [
  ".claude/settings.json",
  ".claude/hooks/*.mjs",
  ".claude/agents/*.md",
  ".claude/skills/**",
  ".claude/rules/*.md",
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

/** Classifies one emitted-project-relative path (POSIX-separated) into a domain. */
export function classifyPath(path: string): DomainClassification {
  if (matchesAnyGlob(path, TYPESCRIPT_DOMAIN_GLOBS)) return "typescript";
  if (matchesAnyGlob(path, HARNESS_DOMAIN_GLOBS)) return "harness";
  if (matchesAnyGlob(path, NEUTRAL_GLOBS)) return "neutral";
  return "uncovered";
}
