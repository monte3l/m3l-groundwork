// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import {
  fixChecksum,
  makeTar,
  makeTarEntries,
  makeTgz,
  makeTgzEntries,
} from "../tarball-fixture.js";

// The pack's scripts carry __PROJECT_NAME__ only in header comments, so they
// run straight from the template directory.
const binDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "templates",
  "packs",
  "publishing",
  "files",
  "bin",
);
const script = join(binDir, "npm-stage-publish.mjs");

const { readTarballManifest, readTarballReadme } = (await import(
  pathToFileURL(join(binDir, "lib", "read-tarball-manifest.mjs")).href
)) as {
  readTarballManifest: (buf: Buffer) => unknown;
  readTarballReadme: (
    buf: Buffer,
  ) => { filename: string; content: string } | undefined;
};
const { parsePublishArgs } = (await import(
  pathToFileURL(join(binDir, "lib", "npm-publish-args.mjs")).href
)) as { parsePublishArgs: (args: string[]) => Record<string, string> };

const manifest = { name: "@scope/name", version: "1.2.3" };
const pkgJson = JSON.stringify(manifest);

describe("pack publishing: tar reader hardening", () => {
  it("parses a valid fixture", () => {
    expect(
      readTarballManifest(makeTgz([["package/package.json", pkgJson]])),
    ).toEqual(manifest);
  });

  it("throws when package/package.json appears twice", () => {
    const tgz = makeTgz([
      ["package/package.json", pkgJson],
      ["package/package.json", '{"name":"evil","version":"9.9.9"}'],
    ]);
    expect(() => readTarballManifest(tgz)).toThrow(/duplicate|more than once/i);
  });

  it.each(["x", "g", "L", "K"])(
    "throws on a %s typeflag entry ahead of package.json",
    (type) => {
      const tgz = makeTgzEntries([
        { name: "package/pax", body: "path=package/other.json\n", type },
        { name: "package/package.json", body: pkgJson },
      ]);
      expect(() => readTarballManifest(tgz)).toThrow(
        /unsupported tar entry type/,
      );
    },
  );

  it("throws on a size field that is only partly octal", () => {
    const tar = makeTar([["package/package.json", "{}"]]);
    tar.write("0000001238\0", 124, "ascii");
    fixChecksum(tar);
    expect(() => readTarballManifest(gzipSync(tar))).toThrow(/bad size/);
  });

  it("throws when the header checksum does not match", () => {
    const tar = makeTar([["package/package.json", pkgJson]]);
    tar.write("0000755", 100, "ascii");
    expect(() => readTarballManifest(gzipSync(tar))).toThrow(/checksum/i);
  });

  function unpadded(entries: { name: string; body: string }[]): Buffer {
    const tar = makeTarEntries(entries);
    return tar.subarray(0, tar.length - 1024);
  }

  it("throws on a nameless non-zero header block instead of ending the scan", () => {
    const block = Buffer.alloc(512);
    block.write("0000644\0", 100, "ascii");
    fixChecksum(block);
    const tar = Buffer.concat([
      unpadded([{ name: "package/package.json", body: pkgJson }]),
      block,
      unpadded([{ name: "package/package.json", body: '{"name":"evil"}' }]),
      Buffer.alloc(1024),
    ]);
    expect(() => readTarballManifest(gzipSync(tar))).toThrow(/empty name/);
  });

  it("still ends the scan at an all-zero block", () => {
    const tar = Buffer.concat([
      unpadded([{ name: "package/package.json", body: pkgJson }]),
      Buffer.alloc(1024),
    ]);
    expect(readTarballManifest(gzipSync(tar))).toEqual(manifest);
  });

  it("readTarballReadme throws when the README name appears twice", () => {
    const tgz = makeTgz([
      ["package/package.json", "{}"],
      ["package/README.md", "one"],
      ["package/README.md", "two"],
    ]);
    expect(() => readTarballReadme(tgz)).toThrow(/duplicate|more than once/i);
  });
});

const repeated = (flag: string): RegExp =>
  new RegExp(
    `${flag}.*(once|twice|repeat|duplicate|more than)|(once|twice|repeat|duplicate|more than).*${flag}`,
    "i",
  );

describe("pack publishing: parsePublishArgs", () => {
  it.each([
    [["a.tgz", "--tag", "a", "--tag", "b"], repeated("--tag")],
    [
      ["a.tgz", "--access", "public", "--access", "restricted"],
      repeated("--access"),
    ],
    [["a.tgz", "--otp", "111111", "--otp", "222222"], repeated("--otp")],
  ])("refuses a repeated flag instead of taking the last (%j)", (args, msg) => {
    expect(() => parsePublishArgs(args)).toThrow(msg);
  });

  it.each(["--dry-run", "-x", "--provenance=false"])(
    "refuses the unknown flag %s",
    (flag) => {
      expect(() => parsePublishArgs(["a.tgz", flag])).toThrow(
        `unsupported flag ${flag}`,
      );
    },
  );

  it("refuses --expect, which only the CLI copy of the parser supports", () => {
    expect(() => parsePublishArgs(["a.tgz", "--expect", "x@1"])).toThrow(
      /unsupported flag --expect/,
    );
  });
});

const ID_TOKEN = "ID-TOKEN";
const NPM_TOKEN = "NPM-EXCHANGED-TOKEN";

/** Fake libnpmpublish: logs what it was given, behaviour chosen by FAKE_PUBLISH. */
const FAKE_LIBNPMPUBLISH = `
const fs = require("node:fs");
exports.publish = async (manifest, tarball, opts) => {
  if (process.env.FAKE_PUBLISH === "throw") throw new Error("publish exploded");
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({
    name: manifest.name, version: manifest.version, readme: manifest.readme, readmeFilename: manifest.readmeFilename, bytes: tarball.length, opts,
  }) + "\\n");
  return process.env.FAKE_PUBLISH === "nostage" ? {} : { stageId: process.env.FAKE_STAGE_ID ?? "stg-1" };
};
`;

/** Fake npm-registry-fetch: a real POST, auth taken from the //host:_authToken key. */
const FAKE_NPM_REGISTRY_FETCH = `
const http = require("node:http");
exports.json = (url, opts) => new Promise((resolve, reject) => {
  const key = Object.keys(opts).find((k) => k.endsWith(":_authToken"));
  const req = http.request(url, { method: opts.method, headers: { Authorization: "Bearer " + opts[key] } }, (res) => {
    let data = "";
    res.on("data", (c) => { data += c; });
    res.on("end", () => {
      let body;
      try { body = JSON.parse(data); } catch { body = {}; }
      if (res.statusCode < 200 || res.statusCode > 299) {
        const err = new Error("HTTP " + res.statusCode);
        err.statusCode = res.statusCode;
        err.body = body;
        reject(err);
      } else resolve(body);
    });
  });
  req.on("error", reject);
  req.end();
});
`;

interface Recorded {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
}

interface Reply {
  status: number;
  body: unknown;
  /** Sent verbatim instead of the JSON body. */
  raw?: string;
  /** Destroy the socket instead of answering. */
  destroy?: boolean;
}

function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve(server);
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

function portOf(server: Server): number {
  return (server.address() as AddressInfo).port;
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

describe("pack publishing: npm-stage-publish", () => {
  let root: string;
  let toolsDir: string;
  let publishLog: string;
  let tarball: string;
  let registry: Server;
  let github: Server;
  let registryReqs: Recorded[];
  let githubReqs: Recorded[];
  let registryReply: Reply;
  let githubReply: Reply;

  function recorder(
    into: Recorded[],
    reply: () => Reply,
  ): (req: IncomingMessage, res: ServerResponse) => void {
    return (req, res) => {
      into.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
      });
      const { status, body, raw, destroy } = reply();
      if (destroy) {
        req.socket.destroy();
        return;
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(raw ?? JSON.stringify(body));
    };
  }

  function writeTarball(files: [string, string][]): void {
    writeFileSync(tarball, makeTgz(files));
  }

  function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
    return {
      RELEASE_TOOLS_DIR: toolsDir,
      NPM_CONFIG_REGISTRY: `http://127.0.0.1:${portOf(registry)}/`,
      FAKE_LOG: publishLog,
      ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${portOf(github)}/token?api=1`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "GH-REQUEST-TOKEN",
      ...extra,
    };
  }

  function published(): {
    name: string;
    version: string;
    readme?: string;
    readmeFilename?: string;
    opts: Record<string, unknown>;
  }[] {
    return existsSync(publishLog)
      ? readFileSync(publishLog, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as never)
      : [];
  }

  function expectNoSecrets(result: RunResult): void {
    for (const out of [result.stdout, result.stderr]) {
      expect(out).not.toContain(ID_TOKEN);
      expect(out).not.toContain(NPM_TOKEN);
    }
  }

  /**
   * The script prints the stage id as a `::warning` workflow command on
   * stdout, so it survives when the file and summary that normally carry it
   * could not be written. It reaches the run page only on a direct run:
   * changesets captures stdout when it drives the publish via
   * pnpm-publish-shim.mjs.
   */
  function expectApproveAnnotation(result: RunResult): void {
    expect(result.stdout).toMatch(
      /^::warning title=Staged @scope\/name@1\.0\.0 \(stg-1\)[^\n]*::npm stage approve stg-1$/m,
    );
  }

  function expectFailure(result: RunResult, message: RegExp): void {
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(message);
    expect(result.stdout).not.toContain("staged with id");
    expectNoSecrets(result);
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "npm-stage-publish-"));
    toolsDir = join(root, "tools");
    publishLog = join(root, "publish.log");
    tarball = join(root, "pkg.tgz");
    const modules = join(toolsDir, "node_modules");
    mkdirSync(join(modules, "libnpmpublish"), { recursive: true });
    mkdirSync(join(modules, "npm-registry-fetch"), { recursive: true });
    writeFileSync(join(toolsDir, "package.json"), "{}");
    writeFileSync(
      join(modules, "libnpmpublish", "index.js"),
      FAKE_LIBNPMPUBLISH,
    );
    writeFileSync(
      join(modules, "npm-registry-fetch", "index.js"),
      FAKE_NPM_REGISTRY_FETCH,
    );
    writeTarball([
      [
        "package/package.json",
        JSON.stringify({ name: "@scope/name", version: "1.0.0" }),
      ],
    ]);

    registryReqs = [];
    githubReqs = [];
    registryReply = { status: 200, body: { token: NPM_TOKEN } };
    githubReply = { status: 200, body: { value: ID_TOKEN } };
    registry = await listen(recorder(registryReqs, () => registryReply));
    github = await listen(recorder(githubReqs, () => githubReply));
  });

  afterEach(async () => {
    await close(registry);
    await close(github);
    rmSync(root, { recursive: true, force: true });
  });

  function writeVersion(version: string): void {
    writeTarball([
      [
        "package/package.json",
        JSON.stringify({ name: "@scope/name", version }),
      ],
    ]);
  }

  it("stages without --expect", async () => {
    const result = await run([tarball, "--tag", "next"], baseEnv());

    expect(result.status).toBe(0);
    expect(published()).toHaveLength(1);
    expectNoSecrets(result);
  });

  it("refuses a prerelease with no --tag before any network call", async () => {
    writeVersion("1.0.0-rc.1");
    const result = await run([tarball], baseEnv());

    expectFailure(result, /prerelease/);
    expect(githubReqs).toEqual([]);
    expect(published()).toEqual([]);
  });

  it("refuses a prerelease explicitly tagged latest before any network call", async () => {
    writeVersion("1.0.0-rc.1");
    const result = await run([tarball, "--tag", "latest"], baseEnv());

    expectFailure(result, /prerelease/);
    expect(result.stderr).not.toMatch(/unsupported flag/);
    expect(githubReqs).toEqual([]);
    expect(registryReqs).toEqual([]);
    expect(published()).toEqual([]);
  });

  it("stages the same prerelease under --tag next", async () => {
    writeVersion("1.0.0-rc.1");
    const result = await run([tarball, "--tag", "next"], baseEnv());

    expect(result.status).toBe(0);
    expect(published()[0]?.opts).toMatchObject({ defaultTag: "next" });
  });

  it.each([
    ["a newline", "stg-1\n::notice::injected"],
    ["a control character", "stg\u0007-1"],
    ["a workflow-command separator", "stg::1"],
    ["a space", "stg 1"],
    ["a slash", "../stg"],
  ])("refuses a stage id containing %s", async (_what, stageId) => {
    const idsFile = join(root, "bad-ids.txt");
    const result = await run(
      [tarball],
      baseEnv({ FAKE_STAGE_ID: stageId, STAGED_IDS_FILE: idsFile }),
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(JSON.stringify(stageId));
    expect(result.stdout).not.toContain("staged with id");
    expect(result.stdout).not.toContain("::notice");
    expect(result.stdout).not.toContain("npm stage approve");
    expect(existsSync(idsFile)).toBe(false);
  });

  it("accepts a stage id of letters, digits, underscore and hyphen", async () => {
    const result = await run(
      [tarball],
      baseEnv({ FAKE_STAGE_ID: "Stg_1-aZ09" }),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("npm stage approve Stg_1-aZ09");
  });

  it("fails through the script's own message when NPM_CONFIG_REGISTRY is not a URL", async () => {
    const result = await run(
      [tarball],
      baseEnv({ NPM_CONFIG_REGISTRY: "not a url" }),
    );

    expectFailure(result, /^npm-stage-publish: .*registry/im);
    expect(result.stderr).not.toMatch(/TypeError|\n\s+at |node:internal/);
    expect(githubReqs).toEqual([]);
    expect(published()).toEqual([]);
  });

  it("warns once with the approve command when STAGED_IDS_FILE is unwritable", async () => {
    const result = await run(
      [tarball],
      baseEnv({ STAGED_IDS_FILE: join(root, "no-such-dir", "ids.txt") }),
    );

    expect(result.status).toBe(0);
    expect(result.stdout.match(/^::warning title=Staged /gm)).toHaveLength(1);
    expectApproveAnnotation(result);
  });

  it("warns once with the approve command when the summary is unwritable", async () => {
    const result = await run(
      [tarball],
      baseEnv({ GITHUB_STEP_SUMMARY: join(root, "no-such-dir", "s.md") }),
    );

    expect(result.status).toBe(0);
    expect(result.stdout.match(/^::warning title=Staged /gm)).toHaveLength(1);
    expectApproveAnnotation(result);
  });

  it("warns once when both the summary and the ids file are unwritable", async () => {
    const result = await run(
      [tarball],
      baseEnv({
        GITHUB_STEP_SUMMARY: join(root, "no-such-dir", "s.md"),
        STAGED_IDS_FILE: join(root, "no-such-dir", "ids.txt"),
      }),
    );

    expect(result.status).toBe(0);
    expect(result.stdout.match(/^::warning title=Staged /gm)).toHaveLength(1);
  });

  it("records the id in STAGED_IDS_FILE on success", async () => {
    const f = join(root, "ids.txt");
    const result = await run([tarball], baseEnv({ STAGED_IDS_FILE: f }));

    expect(result.status).toBe(0);
    expect(readFileSync(f, "utf8")).toBe("@scope/name@1.0.0 stg-1\n");
  });
});
