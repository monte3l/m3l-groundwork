// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTgz } from "./tarball-fixture.js";

const here = dirname(fileURLToPath(import.meta.url));
const binDir = join(here, "..", "..", "..", "bin");

interface PublishArgsLib {
  parsePublishArgs(args: string[]): {
    tarball: string;
    access?: string;
    tag?: string;
    otp?: string;
  };
  pathWithout(
    pathValue: string | undefined,
    dir: string | undefined,
    separator: string,
  ): string;
}

const lib = (await import(
  pathToFileURL(join(binDir, "lib", "npm-publish-args.mjs")).href
)) as PublishArgsLib;

describe("parsePublishArgs", () => {
  it("names changesets' exact pnpm invocation, dropping pnpm-only flags", () => {
    expect(
      lib.parsePublishArgs([
        "pkg.tgz",
        "--json",
        "--access",
        "public",
        "--tag",
        "next",
        "--no-git-checks",
      ]),
    ).toEqual({ tarball: "pkg.tgz", access: "public", tag: "next" });
  });

  it("accepts the tarball in any position and returns an OTP", () => {
    expect(
      lib.parsePublishArgs(["--otp", "123456", "a.tgz", "--access", "public"]),
    ).toEqual({ tarball: "a.tgz", otp: "123456", access: "public" });
  });

  it("returns only the tarball when no flag is given", () => {
    expect(lib.parsePublishArgs(["a.tgz"])).toEqual({ tarball: "a.tgz" });
  });

  it.each([
    [["a.tgz", "--dry-run"], /unsupported flag --dry-run/],
    [["a.tgz", "--tag"], /--tag needs a value/],
    [["a.tgz", "--tag", "--access"], /--tag needs a value/],
    [["--access", "public"], /no tarball given/],
    [["a.tgz", "b.tgz"], /second argument: b\.tgz/],
  ] as [string[], RegExp][])("refuses %j", (args, message) => {
    expect(() => lib.parsePublishArgs(args)).toThrow(message);
  });
});

describe("pathWithout", () => {
  it("removes exactly the named entry", () => {
    expect(lib.pathWithout("/a:/shim:/b", "/shim", ":")).toBe("/a:/b");
  });

  it("leaves PATH alone when there is nothing to remove", () => {
    expect(lib.pathWithout("/a:/b", undefined, ":")).toBe("/a:/b");
    expect(lib.pathWithout("/a:/b", "", ":")).toBe("/a:/b");
    expect(lib.pathWithout(undefined, "/shim", ":")).toBe("");
  });
});

describe("pnpm-publish-shim, wired the way the workflow wires it", () => {
  let root: string;
  let log: string;
  let path: string;

  /** An executable that appends `<label> <args>` to the log, then exits `code`. */
  function fakeTool(dir: string, name: string, code = 0): void {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(
      file,
      `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit ${code}\n`,
    );
    chmodSync(file, 0o755);
  }

  /** An executable that kills itself with SIGKILL. */
  function fakeKilledTool(dir: string, name: string): void {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, "#!/bin/sh\nkill -9 $$\n");
    chmodSync(file, 0o755);
  }

  /** The workflow's generated shim: a `pnpm` that names its dir, then runs the .mjs. */
  function installShim(shimDir: string): void {
    mkdirSync(shimDir, { recursive: true });
    const file = join(shimDir, "pnpm");
    writeFileSync(
      file,
      `#!/bin/sh\nexport PNPM_SHIM_DIR=${shimDir}\nexec node "${join(binDir, "pnpm-publish-shim.mjs")}" "$@"\n`,
    );
    chmodSync(file, 0o755);
  }

  let env: Record<string, string | undefined>;

  function pnpm(...args: string[]): {
    status: number | null;
    stdout: string;
    stderr: string;
  } {
    const result = spawnSync("pnpm", args, {
      env: { ...process.env, PATH: path, ...env },
      encoding: "utf8",
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  /**
   * A RELEASE_TOOLS_DIR with fake libnpmpublish/npm-registry-fetch that log to
   * the same log file, so the real npm-stage-publish.mjs runs end to end.
   */
  function installFakeReleaseTools(publishFails = false): string {
    const tools = join(root, "tools");
    const modules = join(tools, "node_modules");
    mkdirSync(join(modules, "libnpmpublish"), { recursive: true });
    mkdirSync(join(modules, "npm-registry-fetch"), { recursive: true });
    writeFileSync(join(tools, "package.json"), "{}");
    writeFileSync(
      join(modules, "libnpmpublish", "index.js"),
      `exports.publish = async (m, t, o) => {
  if (${String(publishFails)}) throw new Error("registry said no");
  require("node:fs").appendFileSync(${JSON.stringify(log)}, "publish " + m.name + "@" + m.version + " " + o.defaultTag + " " + o.access + " " + o.stage + "\\n");
  return { stageId: "stg-9" };
};\n`,
    );
    writeFileSync(
      join(modules, "npm-registry-fetch", "index.js"),
      `exports.json = async () => ({ token: "t" });\n`,
    );
    return tools;
  }

  function writeTarball(): string {
    const file = join(root, "pkg.tgz");
    writeFileSync(
      file,
      makeTgz([
        [
          "package/package.json",
          JSON.stringify({ name: "@scope/pkg", version: "1.0.0" }),
        ],
      ]),
    );
    return file;
  }

  function logged(): string[] {
    return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pnpm-shim-"));
    env = {
      RELEASE_TOOLS_DIR: undefined,
      NPM_CONFIG_REGISTRY: undefined,
      NPM_ID_TOKEN: "test-id-token",
      GITHUB_STEP_SUMMARY: undefined,
    };
    log = join(root, "calls.log");
    const shimDir = join(root, "shim");
    const realDir = join(root, "real");
    fakeTool(realDir, "pnpm");
    fakeTool(realDir, "npm");
    installShim(shimDir);
    // Shim first, exactly as `echo dir >> $GITHUB_PATH` puts it.
    path = [shimDir, realDir, process.env["PATH"] ?? ""].join(delimiter);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("passes every non-publish command through to the real pnpm, without recursing", () => {
    expect(pnpm("--version").status).toBe(0);
    expect(pnpm("info", "@scope/pkg", "--json").status).toBe(0);

    expect(logged()).toEqual(["pnpm --version", "pnpm info @scope/pkg --json"]);
  });

  it("sends a publish to npm-stage-publish, translated, and never to pnpm or npm", () => {
    env["RELEASE_TOOLS_DIR"] = installFakeReleaseTools();
    const result = pnpm(
      "publish",
      writeTarball(),
      "--json",
      "--access",
      "public",
      "--tag",
      "next",
      "--no-git-checks",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("staged with id stg-9");
    expect(logged()).toEqual(["publish @scope/pkg@1.0.0 next public true"]);
  });

  it("exits 1 and says so when the real pnpm is killed by a signal", () => {
    fakeKilledTool(join(root, "real"), "pnpm");

    const result = pnpm("install");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("was killed by SIGKILL");
  });

  it("exits non-zero when the staged publish fails so the job fails", () => {
    env["RELEASE_TOOLS_DIR"] = installFakeReleaseTools(true);

    const result = pnpm("publish", writeTarball(), "--access", "public");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("registry said no");
    expect(logged()).toEqual([]);
  });

  it("reports the missing release tools instead of falling back to the npm CLI", () => {
    const result = pnpm("publish", writeTarball(), "--access", "public");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("RELEASE_TOOLS_DIR is not set");
    expect(logged()).toEqual([]);
  });

  it("stops before calling anything when the invocation is one it does not understand", () => {
    const result = pnpm("publish", "pkg.tgz", "--dry-run");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsupported flag --dry-run");
    expect(logged()).toEqual([]);
  });
});
