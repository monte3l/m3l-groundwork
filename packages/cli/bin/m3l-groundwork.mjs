#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The published CLI's entry point: `npx @monte3l/groundwork <target-dir>`
 * resolves here. Delegates straight to the built `runCli()` (`main()` plus
 * the one asynchronous mode, `--adopt --apply --dry-run`, awaited only when
 * it returns a Promise) and turns a
 * `CliUsageError` into exit code 2 (`EXIT_CODES.usage`, a bad invocation),
 * any other thrown error into exit code 1 (`EXIT_CODES.runtime`, a runtime
 * failure) -- see `packages/cli/src/main.ts` and `packages/cli/src/exit-codes.ts`.
 * The error is printed with its full `cause` chain (`formatErrorChain`), so
 * a wrapped failure never hides the underlying reason; `handleFatal` sets the
 * exit code before printing and never throws, even when reporting fails --
 * if the painted print throws, it falls back to a plain, unpainted
 * `console.error` (`printRaw`). Not `process.stderr.write`: a write to a
 * closed pipe reports EPIPE asynchronously as an `'error'` event on
 * `process.stderr`, which nothing here listens for, so it would crash the
 * process as an uncaught exception and turn exit code 2 into 1 after
 * `handleFatal` returned; `console.error` swallows stream errors itself.
 *
 * With `--json` (scanned for in argv before `main()` parses it, so a usage
 * error is covered too), stdout carries exactly one `groundwork.report` v1
 * document (`dist/headless/report.js`): `buildReport(result)` after a
 * completed fresh/adopt run, `buildApplyReport(outcome)` after an
 * `--apply --dry-run` outcome (whose `exitCode` -- 0, 3 or 4 -- also becomes
 * the process exit code, with or without `--json`), or -- after `handleFatal` has printed the human
 * report to stderr and set the exit code -- `buildErrorReport(error, code)`
 * with the code `handleFatal` returned. Should serializing that envelope
 * fail anyway (`resolveCliVersion` throwing, say), a minimal literal
 * envelope (`buildErrorReport("unreadable error", code, ...)`) is written
 * instead, so stdout still holds exactly one document. Both go through
 * `console.log` for the same EPIPE reason as above. `--version`/`--list-packs` print their own JSON document
 * inside `main()`; `--help` prints usage text.
 */
import process from "node:process";
import { runCli, CliUsageError } from "../dist/main.js";
import { EXIT_CODES } from "../dist/exit-codes.js";
import { handleFatal } from "../dist/fatal.js";
import {
  buildApplyReport,
  buildErrorReport,
  buildReport,
} from "../dist/headless/report.js";
import { resolveCliVersion } from "../dist/inventory.js";
import { paint } from "../dist/term.js";

const argv = process.argv.slice(2);
// Scanned before main() parses argv, so a usage error still gets its JSON
// envelope.
const json = argv.includes("--json");
const classify = (e) =>
  e instanceof CliUsageError ? EXIT_CODES.usage : EXIT_CODES.runtime;

/** `resolveCliVersion()`, or `"unknown"` when the CLI's own package.json cannot be read. */
const cliVersionOrUnknown = () => {
  try {
    return resolveCliVersion();
  } catch {
    // Only reached on the fallback path, which must not throw.
    return "unknown";
  }
};

let result;
let applyOutcome;
let failed = false;
try {
  const ran = runCli(argv);
  // Only --adopt --apply --dry-run returns a Promise; every other mode ran
  // synchronously above, exactly as before.
  if (ran instanceof Promise) applyOutcome = await ran;
  else result = ran;
} catch (error) {
  failed = true;
  const code = handleFatal(
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
    classify,
    (process.env["M3L_DEBUG"] ?? "") !== "",
  );
  if (json) {
    let envelope;
    try {
      envelope = JSON.stringify(
        buildErrorReport(error, code, { cliVersion: resolveCliVersion() }),
      );
    } catch {
      // buildErrorReport never throws and its output is plain strings, nulls
      // and arrays, but resolveCliVersion can (an unreadable package.json):
      // fall back to a literal envelope, which cannot, so stdout still holds
      // exactly one document.
      envelope = JSON.stringify(
        buildErrorReport("unreadable error", code, {
          cliVersion: cliVersionOrUnknown(),
        }),
      );
    }
    console.log(envelope);
  }
}
// Outside the try/catch above, deliberately: the run has completed and its
// files are on disk, so a failure here must not be dressed up by handleFatal
// as a failed run with an error envelope. That is all this protects: the
// write itself is not guarded, so if buildReport, resolveCliVersion or
// JSON.stringify threw, Node would report an uncaught exception and exit 1
// with nothing on stdout. A closed stdout is not such a failure: console.log
// swallows EPIPE (see the header). --help/--version/--list-packs return
// undefined and have already printed their own output.
if (json && !failed && result !== undefined) {
  console.log(
    JSON.stringify(buildReport(result, { cliVersion: resolveCliVersion() })),
  );
}
// An --apply --dry-run outcome sets its own exit code (0 ok/noop, 3 pending,
// 4 drift) and, under --json, its report; same unguarded write as above.
if (!failed && applyOutcome !== undefined) {
  process.exitCode = applyOutcome.exitCode;
  if (json) {
    console.log(
      JSON.stringify(
        buildApplyReport(applyOutcome, { cliVersion: resolveCliVersion() }),
      ),
    );
  }
}
