#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The published CLI's entry point: `npx @monte3l/groundwork <target-dir>`
 * resolves here. Delegates straight to the built `main()` and turns a
 * `CliUsageError` into exit code 2 (a bad invocation), any other thrown
 * error into exit code 1 (a runtime failure) -- see `packages/cli/src/main.ts`.
 * The error is printed with its full `cause` chain (`formatErrorChain`), so
 * a wrapped failure never hides the underlying reason.
 */
import process from "node:process";
import { main, CliUsageError } from "../dist/main.js";
import { formatErrorChain } from "../dist/format-error.js";
import { paint } from "../dist/term.js";

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(paint(process.stderr, "danger", formatErrorChain(error)));
  process.exitCode = error instanceof CliUsageError ? 2 : 1;
}
