// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The npm package-name rule a project name must satisfy, shared by
 * `main.ts`'s `--name` flag and the answers contract's `fresh.name`
 * (`headless/contract.ts`) so the two cannot drift.
 */

/**
 * A conservative, ASCII-lowercase subset of npm's naming rules (optional
 * `@scope/`). The name is substituted verbatim into the emitted
 * `package.json`; reserved names like `node_modules` are out of scope. Check
 * {@link NPM_NAME_MAX_LENGTH} alongside it.
 *
 * @example
 * ```ts
 * import { NPM_NAME_MAX_LENGTH, NPM_NAME_PATTERN } from "./npm-name.js";
 *
 * const ok = (name: string) =>
 *   name.length <= NPM_NAME_MAX_LENGTH && NPM_NAME_PATTERN.test(name);
 * ok("@scope/pkg"); // true
 * ```
 */
export const NPM_NAME_PATTERN: RegExp =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/**
 * npm's own ceiling on a package name's total length, scope included.
 *
 * @example
 * ```ts
 * import { NPM_NAME_MAX_LENGTH } from "./npm-name.js";
 *
 * const tooLong = "a".repeat(NPM_NAME_MAX_LENGTH + 1);
 * ```
 */
export const NPM_NAME_MAX_LENGTH = 214;

/**
 * The characters a project name may hold: Unicode letters and digits, a
 * space, and `. _ @ / + ~ -`, with no `-` first.
 */
const SAFE_PROJECT_NAME_PATTERN = /^[\p{L}\p{N} ._@/+~][\p{L}\p{N} ._@/+~-]*$/u;

/**
 * Whether `name` is safe to record as the manifest's `PROJECT_NAME`: 1 to
 * {@link NPM_NAME_MAX_LENGTH} characters, each a Unicode letter or digit, a
 * space, or one of `. _ @ / + ~ -`, not starting with `-`. An allowlist, not
 * the npm rule ({@link NPM_NAME_PATTERN} still guards `--name`): fresh mode
 * derives a default name from the directory (`MyApp`, `My App`), and the
 * `/upgrade` skill passes the recorded name to `--name` in a shell command,
 * so a quote, a shell metacharacter, a control character or a leading dash
 * must never get through.
 *
 * @example
 * ```ts
 * import { isSafeProjectName } from "./npm-name.js";
 *
 * isSafeProjectName("My App"); // true
 * isSafeProjectName("$(id)"); // false
 * ```
 */
export function isSafeProjectName(name: string): boolean {
  return (
    name.length <= NPM_NAME_MAX_LENGTH && SAFE_PROJECT_NAME_PATTERN.test(name)
  );
}
