// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const binDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "bin",
);
const script = join(binDir, "deprecate-superseded.mjs");

type Versions = Record<string, { deprecated?: string }>;

/** The 1.0.4-latest world: 1.0.3 and 1.0.2 are the undeprecated ones. */
function freshVersions(): Versions {
  return {
    "0.0.0": { deprecated: "Empty placeholder" },
    "1.0.0": { deprecated: "Superseded by 1.0.1" },
    "1.0.2": {},
    "1.0.3": {},
    "1.0.4": {},
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { PATH: process.env["PATH"] ?? "", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

/**
 * Stub npm: records argv as one JSON line. STUB_NPM_MODE picks the behaviour:
 * "apply" marks the planned versions deprecated on the fake registry (a POST
 * to /__deprecate), "noop" does nothing, "fail" exits 1.
 */
function stubNpmSource(log: string): string {
  return `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const mode = process.env.STUB_NPM_MODE;
if (mode === "fail") process.exit(1);
if (mode !== "apply") process.exit(0);
const [, range, message] = process.argv.slice(2);
const versions = range.replace(/^@[^@]+\\/[^@]+@|^[^@]+@/, "").split(" || ");
fetch(process.env.NPM_CONFIG_REGISTRY + "/__deprecate", {
  method: "POST",
  body: JSON.stringify({ versions, message, late: process.env.STUB_NPM_LATE === "1" }),
}).then(() => process.exit(0), () => process.exit(2));
`;
}

describe("deprecate-superseded", () => {
  let root: string;
  let npmLog: string;
  let registry: Server;
  let versions: Versions;
  let latest: string | undefined;
  let hits: string[];
  let cacheControls: (string | undefined)[];
  let pending: { versions: string[]; message: string } | undefined;
  let readsSincePending: number;
  let env: Record<string, string>;

  function npmCalls(): string[][] {
    return existsSync(npmLog)
      ? readFileSync(npmLog, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as string[])
      : [];
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "deprecate-superseded-"));
    npmLog = join(root, "npm.log");
    const stubDir = join(root, "bin");
    mkdirSync(stubDir);
    const npm = join(stubDir, "npm");
    writeFileSync(npm, stubNpmSource(npmLog));
    chmodSync(npm, 0o755);

    versions = freshVersions();
    latest = "1.0.4";
    hits = [];
    cacheControls = [];
    pending = undefined;
    readsSincePending = 0;
    registry = createServer((req, res) => {
      hits.push(`${req.method ?? ""} ${req.url ?? ""}`);
      if (req.method === "POST" && req.url === "/__deprecate") {
        let data = "";
        req.on("data", (c: Buffer) => (data += c.toString()));
        req.on("end", () => {
          const body = JSON.parse(data) as {
            versions: string[];
            message: string;
            late?: boolean;
          };
          if (body.late === true) {
            pending = body;
            readsSincePending = 0;
          } else {
            for (const v of body.versions) {
              versions[v] = { deprecated: body.message };
            }
          }
          res.end("{}");
        });
        return;
      }
      cacheControls.push(req.headers["cache-control"]);
      if (pending !== undefined && ++readsSincePending >= 3) {
        for (const v of pending.versions) {
          versions[v] = { deprecated: pending.message };
        }
        pending = undefined;
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          name: "@monte3l/groundwork",
          "dist-tags": latest === undefined ? {} : { latest },
          versions,
        }),
      );
    });
    await listen(registry);
    env = {
      PATH: [stubDir, process.env["PATH"] ?? ""].join(delimiter),
      NPM_CONFIG_REGISTRY: `http://127.0.0.1:${String((registry.address() as AddressInfo).port)}`,
      STUB_NPM_MODE: "apply",
      DEPRECATE_VERIFY_DELAY_MS: "10",
    };
  });

  afterEach(async () => {
    await close(registry);
    rmSync(root, { recursive: true, force: true });
  });

  it("dry run prints the plan and the single command, makes no npm call, exits 0", async () => {
    const r = await run([], env);
    expect(r.status).toBe(0);
    expect(npmCalls()).toEqual([]);
    expect(r.stdout).toContain("1.0.3");
    expect(r.stdout).toContain(
      'npm deprecate "@monte3l/groundwork@1.0.3 || 1.0.2" "Superseded by 1.0.4"',
    );
    expect(hits[0]).toMatch(/^GET \/@monte3l%2[fF]groundwork/);
  });

  it("--apply runs npm deprecate exactly once with the exact-version union", async () => {
    const r = await run(["--apply", "--expect", "1.0.4"], env);
    expect(r.status).toBe(0);
    expect(npmCalls()).toEqual([
      [
        "deprecate",
        "@monte3l/groundwork@1.0.3 || 1.0.2",
        "Superseded by 1.0.4",
      ],
    ]);
  });

  it("--apply --otp passes the code through to npm", async () => {
    const r = await run(
      ["--apply", "--expect", "1.0.4", "--otp", "123456"],
      env,
    );
    expect(r.status).toBe(0);
    const calls = npmCalls();
    expect(calls).toHaveLength(1);
    const argv = calls[0] ?? [];
    expect(argv.slice(0, 3)).toEqual([
      "deprecate",
      "@monte3l/groundwork@1.0.3 || 1.0.2",
      "Superseded by 1.0.4",
    ]);
    const i = argv.indexOf("--otp");
    expect(i).toBeGreaterThan(2);
    expect(argv[i + 1]).toBe("123456");
  });

  it("re-fetches after --apply and fails when a planned version still lacks the message", async () => {
    const r = await run(["--apply", "--expect", "1.0.4"], {
      ...env,
      STUB_NPM_MODE: "noop",
    });
    expect(r.status).not.toBe(0);
    expect(npmCalls()).toHaveLength(1);
    expect(
      hits.filter((h) => h.startsWith("GET")).length,
    ).toBeGreaterThanOrEqual(2);
    expect(r.stderr).toMatch(/1\.0\.3|1\.0\.2/);
    expect(r.stderr).toContain("after 6 reads");
    expect(r.stderr).toMatch(/re-?run/i);
    expect(hits.filter((h) => h.startsWith("GET"))).toHaveLength(7);
    expect(cacheControls.every((c) => c === "no-cache")).toBe(true);
  });

  it("polls the registry and succeeds when the messages show up on the 3rd read after npm", async () => {
    const r = await run(["--apply", "--expect", "1.0.4"], {
      ...env,
      STUB_NPM_LATE: "1",
    });
    expect(r.status).toBe(0);
    expect(npmCalls()).toHaveLength(1);
    expect(cacheControls.every((c) => c === "no-cache")).toBe(true);
  });

  it("--apply without --expect refuses, with no npm call and no registry write", async () => {
    const r = await run(["--apply"], env);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--apply requires --expect <version>");
    expect(npmCalls()).toEqual([]);
    expect(hits.filter((h) => h.startsWith("POST"))).toEqual([]);
    expect(versions["1.0.3"]).toEqual({});
  });

  it("--otp without --apply refuses instead of silently ignoring the code", async () => {
    const r = await run(["--otp", "123456"], env);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--otp");
    expect(npmCalls()).toEqual([]);
  });

  it("never echoes the --otp code when npm fails", async () => {
    const r = await run(["--apply", "--expect", "1.0.4", "--otp", "123456"], {
      ...env,
      STUB_NPM_MODE: "fail",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toContain("123456");
  });

  it("refuses a mismatched --expect, with no npm call", async () => {
    const r = await run(["--apply", "--expect", "1.0.5"], env);
    expect(r.status).not.toBe(0);
    expect(npmCalls()).toEqual([]);
    expect(r.stderr).toContain("1.0.5");
  });

  it("accepts a matching --expect", async () => {
    const r = await run(["--apply", "--expect", "1.0.4"], env);
    expect(r.status).toBe(0);
    expect(npmCalls()).toHaveLength(1);
  });

  it("exits non-zero when npm deprecate fails", async () => {
    const r = await run(["--apply", "--expect", "1.0.4"], {
      ...env,
      STUB_NPM_MODE: "fail",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toBe("");
  });

  it("refuses a refused plan with the reason on stderr and no npm call", async () => {
    latest = undefined;
    const r = await run(["--apply", "--expect", "1.0.4"], env);
    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toBe("");
    expect(npmCalls()).toEqual([]);
  });

  it("exits 0 with no npm call when there is nothing to deprecate", async () => {
    versions["1.0.2"] = { deprecated: "Superseded by 1.0.3" };
    versions["1.0.3"] = { deprecated: "Superseded by 1.0.4" };
    const r = await run(["--apply", "--expect", "1.0.4"], env);
    expect(r.status).toBe(0);
    expect(npmCalls()).toEqual([]);
  });
});
