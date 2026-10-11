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
import { fileURLToPath } from "node:url";
import { makeTgz } from "./tarball-fixture.js";

const binDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "bin",
);
const script = join(binDir, "npm-stage-publish.mjs");

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
  return process.env.FAKE_PUBLISH === "nostage" ? {} : { stageId: "stg-1" };
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

describe("npm-stage-publish", () => {
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
  let summary: string;

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
    summary = join(root, "summary.md");
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

  it("exchanges the GitHub token, stages with provenance, and prints the stage id", async () => {
    const result = await run(
      [
        tarball,
        "--json",
        "--access",
        "public",
        "--tag",
        "next",
        "--no-git-checks",
      ],
      baseEnv({ GITHUB_STEP_SUMMARY: summary }),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("@scope/name@1.0.0 (staged with id stg-1)");
    expect(result.stdout).toContain("npm stage approve stg-1");
    expectNoSecrets(result);

    // GitHub was asked for an npm audience for the registry host, with the request token.
    expect(githubReqs).toHaveLength(1);
    expect(githubReqs[0]?.url).toContain("audience=npm%3A127.0.0.1");
    expect(githubReqs[0]?.url).toContain("api=1");
    expect(githubReqs[0]?.authorization).toBe("Bearer GH-REQUEST-TOKEN");

    // Only the slash is escaped (URL keeps a literal @), as the source builds it.
    // The exchange used the GitHub token as Bearer, against the scoped package path.
    expect(registryReqs).toEqual([
      {
        method: "POST",
        url: "/-/npm/v1/oidc/token/exchange/package/@scope%2fname",
        authorization: `Bearer ${ID_TOKEN}`,
      },
    ]);

    const [call] = published();
    expect(call?.name).toBe("@scope/name");
    expect(call?.version).toBe("1.0.0");
    expect(call?.opts).toMatchObject({
      stage: true,
      provenance: true,
      access: "public",
      defaultTag: "next",
      [`//127.0.0.1:${portOf(registry)}/:_authToken`]: NPM_TOKEN,
    });
    expect(call?.opts).not.toHaveProperty("otp");

    const written = readFileSync(summary, "utf8");
    expect(written).toContain("npm stage approve stg-1");
    expect(written).not.toContain(NPM_TOKEN);
  });

  it("defaults the tag to latest and access to null, and forwards an otp", async () => {
    const result = await run([tarball, "--otp", "123456"], baseEnv());

    expect(result.status).toBe(0);
    expect(published()[0]?.opts).toMatchObject({
      access: null,
      defaultTag: "latest",
      otp: "123456",
    });
  });

  it("uses NPM_ID_TOKEN instead of asking GitHub", async () => {
    const result = await run(
      [tarball],
      baseEnv({
        NPM_ID_TOKEN: ID_TOKEN,
        ACTIONS_ID_TOKEN_REQUEST_URL: "",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
      }),
    );

    expect(result.status).toBe(0);
    expect(githubReqs).toEqual([]);
    expect(registryReqs[0]?.authorization).toBe(`Bearer ${ID_TOKEN}`);
  });

  it("fails when the job has no GitHub OIDC environment", async () => {
    const result = await run(
      [tarball],
      baseEnv({
        ACTIONS_ID_TOKEN_REQUEST_URL: "",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
      }),
    );

    expectFailure(result, /id-token: write/);
    expect(registryReqs).toEqual([]);
    expect(published()).toEqual([]);
  });

  it("fails when GitHub refuses the token request", async () => {
    githubReply = { status: 403, body: {} };
    const result = await run([tarball], baseEnv());

    expectFailure(result, /GitHub refused the OIDC token request \(HTTP 403\)/);
    expect(registryReqs).toEqual([]);
  });

  it("fails when GitHub's response carries no token", async () => {
    githubReply = { status: 200, body: {} };
    const result = await run([tarball], baseEnv());

    expectFailure(result, /GitHub's OIDC response carried no token/);
    expect(registryReqs).toEqual([]);
  });

  it("fails with npm's message when the token exchange is refused", async () => {
    registryReply = { status: 401, body: { message: "no trusted publisher" } };
    const result = await run([tarball], baseEnv());

    expectFailure(
      result,
      /token exchange for @scope\/name.*no trusted publisher/,
    );
    expect(published()).toEqual([]);
  });

  it("still exits 0, prints the stage id and warns when the step summary is unwritable", async () => {
    const result = await run(
      [tarball],
      baseEnv({ GITHUB_STEP_SUMMARY: join(root, "no-such-dir", "summary.md") }),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("@scope/name@1.0.0 (staged with id stg-1)");
    expect(result.stdout).toContain("npm stage approve stg-1");
    expect(result.stderr).toMatch(/could not write the step summary/);
    expectNoSecrets(result);
  });

  it("fails with a GitHub OIDC message when the request URL is not a URL", async () => {
    const result = await run(
      [tarball],
      baseEnv({ ACTIONS_ID_TOKEN_REQUEST_URL: "not a url" }),
    );

    expectFailure(
      result,
      /^npm-stage-publish: GitHub OIDC token request failed/m,
    );
    expect(registryReqs).toEqual([]);
    expect(published()).toEqual([]);
  });

  it("fails with a GitHub OIDC message when GitHub answers 200 with non-JSON", async () => {
    githubReply = { status: 200, body: null, raw: "<html>nope</html>" };
    const result = await run([tarball], baseEnv());

    expectFailure(
      result,
      /^npm-stage-publish: GitHub OIDC token request failed/m,
    );
    expect(registryReqs).toEqual([]);
  });

  it("fails with a GitHub OIDC message when GitHub closes the connection", async () => {
    githubReply = { status: 0, body: null, destroy: true };
    const result = await run([tarball], baseEnv());

    expectFailure(
      result,
      /^npm-stage-publish: GitHub OIDC token request failed/m,
    );
    expect(registryReqs).toEqual([]);
  });

  it("reports the underlying error when the token exchange has a network failure", async () => {
    registryReply = { status: 0, body: null, destroy: true };
    const result = await run([tarball], baseEnv());

    expectFailure(result, /token exchange for @scope\/name.*socket hang up/);
    expect(result.stderr).not.toContain("unknown error");
    expect(published()).toEqual([]);
  });

  it("fails when the exchange response carries no token", async () => {
    registryReply = { status: 200, body: {} };
    const result = await run([tarball], baseEnv());

    expectFailure(result, /token exchange response carried no token/);
    expect(published()).toEqual([]);
  });

  it("fails with the reason when libnpmpublish throws", async () => {
    const result = await run([tarball], baseEnv({ FAKE_PUBLISH: "throw" }));

    expectFailure(
      result,
      /staging @scope\/name@1\.0\.0 failed \(the registry may still hold a staged version -- run npm stage list before re-running\): publish exploded/,
    );
  });

  it("adds the tarball README to the manifest it publishes", async () => {
    writeTarball([
      [
        "package/package.json",
        JSON.stringify({ name: "@scope/name", version: "1.0.0" }),
      ],
      ["package/README.md", "# hello"],
    ]);
    const result = await run([tarball], baseEnv());

    expect(result.status).toBe(0);
    expect(published()[0]).toMatchObject({
      readme: "# hello",
      readmeFilename: "README.md",
    });
  });

  it("keeps a readme the manifest already carries", async () => {
    writeTarball([
      [
        "package/package.json",
        JSON.stringify({
          name: "@scope/name",
          version: "1.0.0",
          readme: "from manifest",
        }),
      ],
      ["package/README.md", "# from file"],
    ]);
    const result = await run([tarball], baseEnv());

    expect(result.status).toBe(0);
    expect(published()[0]?.readme).toBe("from manifest");
    expect(published()[0]?.readmeFilename).toBeUndefined();
  });

  it("publishes without a readme when the tarball has none", async () => {
    const result = await run([tarball], baseEnv());

    expect(result.status).toBe(0);
    expect(published()[0]?.readme).toBeUndefined();
  });

  it("refuses a prerelease without --tag before any network call", async () => {
    writeTarball([
      [
        "package/package.json",
        JSON.stringify({ name: "@scope/name", version: "1.0.0-rc.1" }),
      ],
    ]);
    const result = await run([tarball], baseEnv());

    expectFailure(result, /prerelease/);
    expect(githubReqs).toEqual([]);
    expect(registryReqs).toEqual([]);
    expect(published()).toEqual([]);
  });

  it("stages a prerelease when --tag is given", async () => {
    writeTarball([
      [
        "package/package.json",
        JSON.stringify({ name: "@scope/name", version: "1.0.0-rc.1" }),
      ],
    ]);
    const result = await run([tarball, "--tag", "rc"], baseEnv());

    expect(result.status).toBe(0);
    expect(published()[0]?.opts).toMatchObject({ defaultTag: "rc" });
  });

  it("fails when libnpmpublish returns no stage id", async () => {
    const result = await run([tarball], baseEnv({ FAKE_PUBLISH: "nostage" }));

    expectFailure(result, /returned no stage id/);
  });

  it("fails when RELEASE_TOOLS_DIR is unset", async () => {
    const env = baseEnv();
    delete env["RELEASE_TOOLS_DIR"];
    const result = await run([tarball], env);

    expectFailure(result, /RELEASE_TOOLS_DIR is not set/);
  });

  it("fails when the release tools are not installed", async () => {
    const empty = join(root, "empty");
    mkdirSync(empty);
    const result = await run([tarball], baseEnv({ RELEASE_TOOLS_DIR: empty }));

    expectFailure(result, /cannot load libnpmpublish from .*npm ci/);
  });

  it("fails on a tarball that is not a gzip", async () => {
    writeFileSync(tarball, "plain text");
    const result = await run([tarball], baseEnv());

    expectFailure(result, /cannot read .*not valid gzip/);
  });

  it("fails on a tarball path that does not exist", async () => {
    const result = await run([join(root, "missing.tgz")], baseEnv());

    expectFailure(result, /cannot read .*missing\.tgz/);
  });

  it("fails when the manifest has no name and version", async () => {
    writeTarball([["package/package.json", '{"name":"x"}']]);
    const result = await run([tarball], baseEnv());

    expectFailure(result, /package\.json has no name and version/);
  });

  it("refuses an unsupported flag before touching the network", async () => {
    const result = await run([tarball, "--dry-run"], baseEnv());

    expectFailure(result, /unsupported flag --dry-run/);
    expect(githubReqs).toEqual([]);
    expect(registryReqs).toEqual([]);
  });
});
