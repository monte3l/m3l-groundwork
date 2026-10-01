#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The published CLI's entry point: `npx @monte3l/groundwork <target-dir>`
 * resolves here. Delegates straight to the built `main()` and turns a
 * `CliUsageError` into exit code 2 (a bad invocation), any other thrown
 * error into exit code 1 (a runtime failure) -- see `packages/cli/src/main.ts`.
 * The error is printed with its full `cause` chain (`formatErrorChain`), so
 * a wrapped failure never hides the underlying reason; `handleFatal` sets the
 * exit code before printing and never throws, even when reporting fails --
 * if the painted print throws, it falls back to a plain, unpainted
 * `console.error` (`printRaw`). Not `process.stderr.write`: a write to a
 * closed pipe reports EPIPE asynchronously as an `'error'` event on
 * `process.stderr`, which nothing here listens for, so it would crash the
 * process as an uncaught exception and turn exit code 2 into 1 after
 * `handleFatal` returned; `console.error` swallows stream errors itself.
 */
import process from "node:process";
import { main, CliUsageError } from "../dist/main.js";
import { handleFatal } from "../dist/fatal.js";
import { paint } from "../dist/term.js";

try {
  main(process.argv.slice(2));
} catch (error) {
  handleFatal(
    error,
    {
      setExitCode: (code) => {
        process.exitCode = code;
      },
      print: (text) => {
        console.error(paint(process.stderr, "danger", text));
      },
      printRaw: (text) => {
        console.error(text);
      },
    },
    (e) => e instanceof CliUsageError,
  );
}
