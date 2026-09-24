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

const here = dirname(fileURLToPath(import.meta.url));
const binDir = join(here, "..", "..", "..", "bin");

interface PublishArgsLib {
  toNpmStagePublishArgs(args: string[]): string[];
  pathWithout(
    pathValue: string | undefined,
    dir: string | undefined,
    separator: string,
  ): string;
}

const lib = (await import(
  pathToFileURL(join(binDir, "lib", "npm-publish-args.mjs")).href
)) as PublishArgsLib;

describe("toNpmStagePublishArgs", () => {
  it("translates changesets' exact pnpm invocation", () => {
    expect(
      lib.toNpmStagePublishArgs([
        "../.changeset-pack/pkg-1.0.0.tgz",
        "--json",
        "--access",
        "public",
        "--tag",
        "next",
        "--no-git-checks",
      ]),
    ).toEqual([
      "stage",
      "publish",
      "../.changeset-pack/pkg-1.0.0.tgz",
      "--access",
      "public",
      "--tag",
      "next",
      "--provenance",
    ]);
  });

  it("accepts the tarball in any position and forwards an OTP", () => {
    expect(
      lib.toNpmStagePublishArgs([
        "--access",
        "public",
        "--otp",
        "123456",
        "a.tgz",
      ]),
    ).toEqual([
      "stage",
      "publish",
      "a.tgz",
      "--access",
      "public",
      "--otp",
      "123456",
      "--provenance",
    ]);
  });

  it("refuses a flag it does not know rather than guessing", () => {
    expect(() => lib.toNpmStagePublishArgs(["a.tgz", "--dry-run"])).toThrow(
      /unsupported flag --dry-run/,
    );
  });

  it("refuses a value-taking flag with no value", () => {
    expect(() => lib.toNpmStagePublishArgs(["a.tgz", "--tag"])).toThrow(
      /--tag needs a value/,
    );
    expect(() =>
      lib.toNpmStagePublishArgs(["a.tgz", "--tag", "--access"]),
    ).toThrow(/--tag needs a value/);
  });

  it("refuses to publish a directory: only tarballs", () => {
    expect(() => lib.toNpmStagePublishArgs(["--access", "public"])).toThrow(
      /no tarball given/,
    );
  });

  it("refuses two positional arguments", () => {
    expect(() => lib.toNpmStagePublishArgs(["a.tgz", "b.tgz"])).toThrow(
      /second argument: b\.tgz/,
    );
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

  function pnpm(...args: string[]): { status: number | null; stderr: string } {
    const result = spawnSync("pnpm", args, {
      env: { ...process.env, PATH: path },
      encoding: "utf8",
    });
    return { status: result.status, stderr: result.stderr };
  }

  function logged(): string[] {
    return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pnpm-shim-"));
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

  it("sends a staged publish to npm, translated, and never to pnpm", () => {
    const result = pnpm(
      "publish",
      "pkg.tgz",
      "--json",
      "--access",
      "public",
      "--tag",
      "latest",
      "--no-git-checks",
    );

    expect(result.status).toBe(0);
    expect(logged()).toEqual([
      "npm stage publish pkg.tgz --access public --tag latest --provenance",
    ]);
  });

  it("exits with npm's own status so a failed publish fails the job", () => {
    fakeTool(join(root, "real"), "npm", 3);

    expect(pnpm("publish", "pkg.tgz", "--access", "public").status).toBe(3);
  });

  it("stops before calling anything when the invocation is one it does not understand", () => {
    const result = pnpm("publish", "pkg.tgz", "--dry-run");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsupported flag --dry-run");
    expect(logged()).toEqual([]);
  });
});
