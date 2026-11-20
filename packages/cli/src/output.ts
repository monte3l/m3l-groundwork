// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Routes the CLI's status lines. In human mode every line goes to the same
 * stream, with the same trailing newline, as `console.log` (`info`,
 * `success`) or `console.error` (`warn`) would send it, including when a
 * stream is injected; json mode sends every line to stderr so stdout stays
 * free for a machine-readable result. Colour is decided per stream by
 * {@link paint}.
 */
import process from "node:process";
import { paint } from "./term.js";

/**
 * The CLI's status-line sink: `info` for plain lines, `success` for the
 * closing "ready" line (painted with the success role), `warn` for warnings
 * (painted with the warning role, always on stderr).
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
 * Builds an {@link Out}. In human mode `info`/`success` go to stdout and
 * `warn` to stderr -- through `console.log`/`console.error` unless a stream
 * is injected. In json mode all three go to stderr, painted according to
 * the stderr stream's colour support.
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
  if (json) {
    const sink = stderr ?? process.stderr;
    return {
      info: (msg) => {
        writeLine(sink, msg);
      },
      success: (msg) => {
        writeLine(sink, paint(sink, "success", msg));
      },
      warn: (msg) => {
        writeLine(sink, paint(sink, "warning", msg));
      },
    };
  }
  const toStdout = (msg: string): void => {
    if (stdout === undefined) console.log(msg);
    else writeLine(stdout, msg);
  };
  const toStderr = (msg: string): void => {
    if (stderr === undefined) console.error(msg);
    else writeLine(stderr, msg);
  };
  return {
    info: toStdout,
    success: (msg) => {
      toStdout(paint(stdout ?? process.stdout, "success", msg));
    },
    warn: (msg) => {
      toStderr(paint(stderr ?? process.stderr, "warning", msg));
    },
  };
}
