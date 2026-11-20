// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Routes the CLI's status lines. In human mode every line goes to the same
 * stream, with the same trailing newline, as `console.log` (`info`,
 * `notice`, `success`) or `console.error` (`warn`) would send it, including when a
 * stream is injected; json mode sends every line to stderr so stdout stays
 * free for a machine-readable result -- through `console.error` unless a
 * stderr is injected, never a direct `process.stderr.write` (whose EPIPE on a
 * closed pipe would surface as an unhandled `'error'` event; the header of
 * `bin/m3l-groundwork.mjs` explains why `console.error` is safe). Colour is
 * decided per stream by {@link paint}.
 */
import process from "node:process";
import { paint } from "./term.js";

/**
 * The CLI's status-line sink: `info` for plain lines, `notice` for a
 * warning-painted status line that belongs with the run's normal output (the
 * over-cap summary, the pack setup block -- stdout in human mode, stderr in
 * json mode), `success` for the closing "ready" line (painted with the
 * success role), `warn` for warnings (painted with the warning role, always
 * on stderr).
 *
 * @example
 * ```ts
 * import { createOut, type Out } from "./output.js";
 * const out: Out = createOut({ json: false });
 * out.info("wrote 12 files");
 * ```
 */
export interface Out {
  readonly info: (msg: string) => void;
  readonly notice: (msg: string) => void;
  readonly warn: (msg: string) => void;
  readonly success: (msg: string) => void;
}

/** Options for {@link createOut}; the streams default to the process's own. */
interface CreateOutOptions {
  readonly json: boolean;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
}

/** Writes `msg` plus a newline to `stream`. */
function writeLine(stream: NodeJS.WriteStream, msg: string): void {
  stream.write(`${msg}\n`);
}

/**
 * Builds an {@link Out}. In human mode `info`/`notice`/`success` go to
 * stdout and `warn` to stderr -- through `console.log`/`console.error`
 * unless a stream is injected, each painted for its own stream. In json mode
 * all four go to stderr -- through `console.error` unless a stderr is
 * injected, in which case `msg` plus a newline is written to it -- painted
 * according to the stderr stream's colour support.
 *
 * @example
 * ```ts
 * import { createOut } from "./output.js";
 * const out = createOut({ json: true });
 * out.success("done"); // written to stderr
 * ```
 */
export function createOut(options: CreateOutOptions): Out {
  const { json, stdout, stderr } = options;
  const toStderr = (msg: string): void => {
    if (stderr === undefined) console.error(msg);
    else writeLine(stderr, msg);
  };
  if (json) {
    const paintTarget = stderr ?? process.stderr;
    return {
      info: toStderr,
      notice: (msg) => {
        toStderr(paint(paintTarget, "warning", msg));
      },
      success: (msg) => {
        toStderr(paint(paintTarget, "success", msg));
      },
      warn: (msg) => {
        toStderr(paint(paintTarget, "warning", msg));
      },
    };
  }
  const toStdout = (msg: string): void => {
    if (stdout === undefined) console.log(msg);
    else writeLine(stdout, msg);
  };
  return {
    info: toStdout,
    notice: (msg) => {
      toStdout(paint(stdout ?? process.stdout, "warning", msg));
    },
    success: (msg) => {
      toStdout(paint(stdout ?? process.stdout, "success", msg));
    },
    warn: (msg) => {
      toStderr(paint(stderr ?? process.stderr, "warning", msg));
    },
  };
}
