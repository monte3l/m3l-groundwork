// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Token substitution: a fixed string-replace table, not a template engine --
 * the CLI has zero runtime dependencies it can avoid, and a `__TOKEN__`
 * literal replace is all `templates/core` needs.
 */
export type TokenTable = Record<string, string>;

/**
 * Replaces every `__KEY__` occurrence in `content` with `tokens[KEY]`, for
 * every key in `tokens`. Unmatched `__KEY__`-shaped text that isn't a known
 * token is left untouched.
 */
export function applyTokens(content: string, tokens: TokenTable): string {
  let result = content;
  for (const [key, value] of Object.entries(tokens)) {
    result = result.split(`__${key}__`).join(value);
  }
  return result;
}

// A project name is substituted verbatim into the emitted package.json, so it
// must fit a conservative, ASCII-lowercase subset of npm's naming rules
// (optional @scope/). Reserved names like `node_modules` are out of scope.
const NPM_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/** npm's own ceiling on a package name's total length, scope included. */
export const NPM_NAME_MAX_LENGTH = 214;

/**
 * Whether `name` is a project name the CLI accepts for `__PROJECT_NAME__`: a
 * conservative, ASCII-lowercase subset of npm's package-name rules (optional
 * `@scope/`), at most {@link NPM_NAME_MAX_LENGTH} characters.
 *
 * @example
 * ```ts
 * isNpmPackageName("@acme/widgets"); // true
 * isNpmPackageName("Not Valid"); // false
 * ```
 */
export function isNpmPackageName(name: string): boolean {
  return name.length <= NPM_NAME_MAX_LENGTH && NPM_NAME_PATTERN.test(name);
}

/**
 * The token table every emit uses: `PROJECT_NAME` and the current `YEAR`.
 *
 * @example
 * ```ts
 * buildTokens("acme"); // { PROJECT_NAME: "acme", YEAR: "2026" } in 2026
 * ```
 */
export function buildTokens(projectName: string): TokenTable {
  return { PROJECT_NAME: projectName, YEAR: String(new Date().getFullYear()) };
}
