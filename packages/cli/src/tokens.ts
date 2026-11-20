// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Token substitution: a fixed string-replace table, not a template engine --
 * the CLI has zero runtime dependencies it can avoid, and a `__TOKEN__`
 * literal replace is all `templates/core` needs.
 */
export type TokenTable = Record<string, string>;

/**
 * The exact token keys every bootstrap records: fresh mode's `buildTokens`
 * (`main.ts`) is typed against this tuple, and the upgrade plan
 * (`upgrade/plan.ts`) refuses a manifest whose tokens hold any other key set,
 * so adding a key here without the other breaks the build.
 *
 * @example
 * ```ts
 * import { REQUIRED_TOKEN_KEYS } from "./tokens.js";
 *
 * REQUIRED_TOKEN_KEYS.includes("YEAR"); // true
 * ```
 */
export const REQUIRED_TOKEN_KEYS: readonly ["PROJECT_NAME", "YEAR"] = [
  "PROJECT_NAME",
  "YEAR",
] as const;

/**
 * One of {@link REQUIRED_TOKEN_KEYS}.
 *
 * @example
 * ```ts
 * import type { RequiredTokenKey } from "./tokens.js";
 *
 * const table: Record<RequiredTokenKey, string> = { PROJECT_NAME: "app", YEAR: "2026" };
 * ```
 */
export type RequiredTokenKey = (typeof REQUIRED_TOKEN_KEYS)[number];

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
