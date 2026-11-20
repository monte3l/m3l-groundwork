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
