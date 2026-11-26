// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `runCheckUpdate` failure ordering. ASSUMED: `CheckUpdateDeps.coreDir?` is
 * an explicit override (a missing one is compared as an empty tree, for
 * fixtures); with no override the production default `templates/core` is
 * resolved through `resolveAsset`, and a missing directory throws a plain
 * `Error` naming the path. Everything is computed before the first
 * `console.log`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheckUpdate } from "../src/check-update.js";
import { resolveAsset } from "../src/assets.js";
import type * as AssetsModule from "../src/assets.js";
import { inspectPackInstallations } from "../src/pack-installation.js";
import type * as PackInstallationModule from "../src/pack-installation.js";
import { CliUsageError } from "../src/usage.js";
import type { TemplateHistory } from "../src/template-history.js";
import { bootstrapInto } from "./add-pack-fixtures.js";

vi.mock("../src/assets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof AssetsModule>();
  return { ...actual, resolveAsset: vi.fn(actual.resolveAsset) };
});
vi.mock("../src/pack-installation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof PackInstallationModule>();
  return {
    ...actual,
    inspectPackInstallations: vi.fn(actual.inspectPackInstallations),
  };
});

let root: string;
let project: string;
const history: { history: TemplateHistory } = {
  history: {
    schemaVersion: 1,
    versions: {
      "1.0.0": { core: { "package.json": "0".repeat(64) }, packs: {} },
    },
    blobs: {},
  },
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "check-update-fail-"));
  project = join(root, "project");
  bootstrapInto(project);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(resolveAsset).mockReset();
  vi.mocked(inspectPackInstallations).mockReset();
  rmSync(root, { recursive: true, force: true });
});

describe("runCheckUpdate failures", () => {
  it("throws a plain Error naming the path when the CLI's own templates/core is missing, printing nothing", async () => {
    const actual =
      await vi.importActual<typeof AssetsModule>("../src/assets.js");
    const missing = join(root, "no-such-core");
    vi.mocked(resolveAsset).mockImplementation((paths, from) =>
      paths.repo === "templates/core"
        ? missing
        : actual.resolveAsset(paths, from),
    );
    let thrown: unknown;
    try {
      runCheckUpdate(
        { targetDir: project, baseVersion: "1.0.0" },
        { history, runningVersion: "1.1.0" },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(CliUsageError);
    expect((thrown as Error).message).toContain(missing);
    expect(console.log).not.toHaveBeenCalled();
  });

  it("prints nothing when the pack inspection throws", () => {
    vi.mocked(inspectPackInstallations).mockImplementation(() => {
      throw new Error("inspection blew up");
    });
    expect(() =>
      runCheckUpdate(
        { targetDir: project, baseVersion: "1.0.0" },
        { history, runningVersion: "1.1.0" },
      ),
    ).toThrowError("inspection blew up");
    expect(console.log).not.toHaveBeenCalled();
  });
});
