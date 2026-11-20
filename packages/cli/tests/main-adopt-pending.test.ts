// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `runAdopt` under `--json` also writes `.groundwork/headless/pending.json`
 * (an answers v1 partial document bound to inventory.json's sha256), after
 * inventory.json. Without `--json` nothing changes, and a re-run removes a
 * previous pending file first so it can never outlive the inventory it is
 * bound to. The RunResult carries the entries and the relative path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  lstatSync,
} from "node:fs";
import type * as FsModule from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Out } from "../src/output.js";
import { validateAnswers, type AnswersV1 } from "../src/headless/contract.js";

const {
  writeFileSyncMock,
  rmSyncMock,
  rmdirSyncMock,
  mkdirSyncMock,
  renameSyncMock,
} = vi.hoisted(() => ({
  writeFileSyncMock: vi.fn(),
  rmSyncMock: vi.fn(),
  rmdirSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  renameSyncMock: vi.fn(),
}));

vi.mock("../src/git.js", () => ({ gitInit: vi.fn(), runInstall: vi.fn() }));
vi.mock("../src/plugin.js", () => ({
  installCustomizeSkill: vi.fn(() => ({ filesWritten: [] })),
  installCustomizeSkillGuarded: vi.fn(() => ({
    filesWritten: [],
    location: "claude" as const,
  })),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) =>
      writeFileSyncMock(...args) as ReturnType<typeof actual.writeFileSync>,
    rmSync: (...args: Parameters<typeof actual.rmSync>) =>
      rmSyncMock(...args) as ReturnType<typeof actual.rmSync>,
    rmdirSync: (...args: Parameters<typeof actual.rmdirSync>) =>
      rmdirSyncMock(...args) as ReturnType<typeof actual.rmdirSync>,
    mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) =>
      mkdirSyncMock(...args) as ReturnType<typeof actual.mkdirSync>,
    renameSync: (...args: Parameters<typeof actual.renameSync>) =>
      renameSyncMock(...args) as ReturnType<typeof actual.renameSync>,
  };
});

const { main, assertAdoptWriteScope } = await import("../src/main.js");

const out = {
  info: vi.fn(),
  notice: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
} satisfies Out;

const PENDING_REL = ".groundwork/headless/pending.json";

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("runAdopt pending document", () => {
  let root: string;
  let project: string;
  let realWriteFileSync: typeof FsModule.writeFileSync;
  let realRmSync: typeof FsModule.rmSync;
  let realRmdirSync: typeof FsModule.rmdirSync;
  let realMkdirSync: typeof FsModule.mkdirSync;
  let realRenameSync: typeof FsModule.renameSync;
  const pendingPath = () =>
    join(project, ".groundwork", "headless", "pending.json");
  const readPending = () =>
    JSON.parse(readFileSync(pendingPath(), "utf8")) as AnswersV1;

  beforeEach(async () => {
    const fsActual = await vi.importActual<typeof FsModule>("node:fs");
    realWriteFileSync = fsActual.writeFileSync;
    realRmSync = fsActual.rmSync;
    realRmdirSync = fsActual.rmdirSync;
    realMkdirSync = fsActual.mkdirSync;
    realRenameSync = fsActual.renameSync;
    writeFileSyncMock.mockReset();
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof realWriteFileSync>) =>
        realWriteFileSync(...args),
    );
    rmSyncMock.mockReset();
    rmSyncMock.mockImplementation((...args: Parameters<typeof realRmSync>) =>
      realRmSync(...args),
    );
    rmdirSyncMock.mockReset();
    rmdirSyncMock.mockImplementation(
      (...args: Parameters<typeof realRmdirSync>) => realRmdirSync(...args),
    );
    mkdirSyncMock.mockReset();
    mkdirSyncMock.mockImplementation(
      (...args: Parameters<typeof realMkdirSync>) => realMkdirSync(...args),
    );
    renameSyncMock.mockReset();
    renameSyncMock.mockImplementation(
      (...args: Parameters<typeof realRenameSync>) => realRenameSync(...args),
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    root = mkdtempSync(join(tmpdir(), "main-adopt-pending-"));
    project = join(root, "project");
    mkdirSync(project);
    // package.json and tsconfig.json both diverge from the baseline's
    // (key-level conflicts; package.json is listed first); the baseline's
    // other files are absent.
    realWriteFileSync(
      join(project, "package.json"),
      JSON.stringify({ name: "acme", type: "module" }),
    );
    realWriteFileSync(
      join(project, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: false } }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    writeFileSyncMock.mockReset();
    rmSyncMock.mockReset();
    rmdirSyncMock.mockReset();
    mkdirSyncMock.mockReset();
    renameSyncMock.mockReset();
    rmSync(root, { recursive: true, force: true });
  });

  it("--json writes pending.json after inventory.json: 2-space JSON, trailing newline, bound to the inventory's exact bytes", () => {
    main([project, "--json"], "linux", out);

    const text = readFileSync(pendingPath(), "utf8");
    const doc = JSON.parse(text) as AnswersV1;
    expect(text).toBe(`${JSON.stringify(doc, null, 2)}\n`);
    expect(doc.mode).toBe("adopt");
    expect(doc.basis).toEqual({
      inventorySha256: sha256(join(project, ".groundwork", "inventory.json")),
    });
    expect(doc.basis).toMatchObject({
      inventorySha256: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
    });
    expect(doc.interview.kind).toBeNull();
    expect(doc.interview.runtime).toBeNull();
    expect(validateAnswers(doc, "partial").ok).toBe(true);
    expect(validateAnswers(doc, "complete").ok).toBe(false);
  });

  it("lists the divergent file as an unresolved conflict and each absent file as an add", () => {
    main([project, "--json"], "linux", out);

    const doc = readPending();
    expect(doc.adopt?.conflicts).toEqual([
      { path: "package.json", resolution: null },
      { path: "tsconfig.json", resolution: null },
    ]);
    expect(doc.adopt?.additions.length).toBeGreaterThan(0);
    expect(doc.adopt?.additions.every((a) => a.action === "add")).toBe(true);
    expect(doc.adopt?.additions.map((a) => a.path)).not.toContain(
      "tsconfig.json",
    );
    expect(doc.pending.map((p) => p.pointer)).toEqual([
      "/interview/kind",
      "/interview/runtime",
      "/adopt/conflicts/0/resolution",
      "/adopt/conflicts/1/resolution",
    ]);
  });

  it("writes it atomically: no temp file is left in .groundwork/headless/", () => {
    main([project, "--json"], "linux", out);
    expect(readdirSync(join(project, ".groundwork", "headless"))).toEqual([
      "pending.json",
    ]);
  });

  it("returns the entries and the relative path in the RunResult", () => {
    const result = main([project, "--json"], "linux", out);
    const doc = readPending();
    expect(result?.mode).toBe("adopt");
    expect(result).toMatchObject({ pendingPath: PENDING_REL });
    expect(result?.pending).toEqual(doc.pending);
  });

  it("without --json writes no headless directory and the RunResult carries [] and null", () => {
    const result = main([project], "linux", out);
    expect(existsSync(join(project, ".groundwork", "headless"))).toBe(false);
    expect(existsSync(join(project, ".groundwork", "inventory.json"))).toBe(
      true,
    );
    expect(result).toMatchObject({ pending: [], pendingPath: null });
  });

  it("a fresh run's RunResult carries [] and null", () => {
    const result = main([join(root, "fresh"), "--skip-install"], "linux", out);
    expect(result).toMatchObject({
      mode: "fresh",
      pending: [],
      pendingPath: null,
    });
  });

  it("does not touch a project file", () => {
    const before = readFileSync(join(project, "tsconfig.json"), "utf8");
    main([project, "--json"], "linux", out);
    expect(readFileSync(join(project, "tsconfig.json"), "utf8")).toBe(before);
  });

  it("a re-run under --json replaces pending.json with one bound to the new inventory", () => {
    main([project, "--json"], "linux", out);
    const first = readPending();
    realWriteFileSync(
      join(project, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, target: "es2022" } }),
    );

    main([project, "--json"], "linux", out);

    const second = readPending();
    expect(second.basis).toEqual({
      inventorySha256: sha256(join(project, ".groundwork", "inventory.json")),
    });
    expect(second.basis).not.toEqual(first.basis);
  });

  it("a re-run without --json deletes a previous pending.json and the empty headless directory", () => {
    main([project, "--json"], "linux", out);
    expect(existsSync(pendingPath())).toBe(true);

    main([project], "linux", out);

    expect(existsSync(pendingPath())).toBe(false);
    expect(existsSync(join(project, ".groundwork", "headless"))).toBe(false);
  });

  it("a re-run without --json leaves a headless directory that holds something else", () => {
    main([project, "--json"], "linux", out);
    mkdirSync(join(project, ".groundwork", "headless"), { recursive: true });
    realWriteFileSync(
      join(project, ".groundwork", "headless", "notes.txt"),
      "mine",
    );

    main([project], "linux", out);

    expect(existsSync(pendingPath())).toBe(false);
    expect(
      readFileSync(
        join(project, ".groundwork", "headless", "notes.txt"),
        "utf8",
      ),
    ).toBe("mine");
  });

  it("deletes a stale pending.json before anything else is written: a run that then fails leaves none", () => {
    main([project, "--json"], "linux", out);
    expect(existsSync(pendingPath())).toBe(true);
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof realWriteFileSync>) => {
        if (String(args[0]).includes("adoption-report.md")) {
          throw new Error("simulated report failure");
        }
        return realWriteFileSync(...args);
      },
    );

    expect(() => main([project, "--json"], "linux", out)).toThrow(/re-run/);

    expect(existsSync(pendingPath())).toBe(false);
  });

  it("a pending write failure is a runtime error naming pending.json with the cause chained; inventory.json stays", () => {
    const failure = new Error("simulated pending write failure");
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof realWriteFileSync>) => {
        if (String(args[0]).includes("pending.json")) throw failure;
        return realWriteFileSync(...args);
      },
    );

    let thrown: unknown;
    try {
      main([project, "--json"], "linux", out);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("pending.json");
    const chain: unknown[] = [];
    for (let e: unknown = thrown; e instanceof Error; e = e.cause)
      chain.push(e);
    expect(chain).toContain(failure);
    expect(existsSync(join(project, ".groundwork", "inventory.json"))).toBe(
      true,
    );
    expect(existsSync(pendingPath())).toBe(false);
  });

  it("when removing the temp file also fails, still throws the pending.json error with the original cause and warns about the temp file", () => {
    const failure = new Error("simulated pending write failure");
    const cleanupFailure = new Error("simulated temp removal failure");
    let writeFailed = false;
    writeFileSyncMock.mockImplementation(
      (...args: Parameters<typeof realWriteFileSync>) => {
        if (String(args[0]).includes("pending.json")) {
          writeFailed = true;
          throw failure;
        }
        return realWriteFileSync(...args);
      },
    );
    // Only the cleanup after the failed write fails, so the write failure
    // (not the cleanup one) is the cause that gets reported.
    rmSyncMock.mockImplementation((...args: Parameters<typeof realRmSync>) => {
      if (writeFailed && String(args[0]).endsWith("pending.json.tmp"))
        throw cleanupFailure;
      return realRmSync(...args);
    });

    let thrown: unknown;
    try {
      main([project, "--json"], "linux", out);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("pending.json");
    const chain: unknown[] = [];
    for (let e: unknown = thrown; e instanceof Error; e = e.cause)
      chain.push(e);
    expect(chain).toContain(failure);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("pending.json.tmp"),
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining(cleanupFailure.message),
    );
  });

  // ---- hardening of the headless directory and pending temp path ----

  const gw = () => join(project, ".groundwork");
  const headless = () => join(gw(), "headless");
  const tmpPath = () => `${pendingPath()}.tmp`;
  const chainOf = (error: unknown): unknown[] => {
    const chain: unknown[] = [];
    for (let e: unknown = error; e instanceof Error; e = e.cause) chain.push(e);
    return chain;
  };
  const attempt = (args: string[]): unknown => {
    try {
      main(args, "linux", out);
    } catch (error) {
      return error;
    }
    return undefined;
  };

  /** Adopts once, plants the two /customize-written files, returns every previous artifact's bytes. */
  function previousArtifacts(): Map<string, string> {
    main([project], "linux", out);
    realWriteFileSync(join(gw(), "adoption-decisions.json"), "{}\n");
    realWriteFileSync(join(gw(), "customization-report.md"), "# mine\n");
    const names = [
      "inventory.json",
      "adoption-report.md",
      "adoption-decisions.json",
      "customization-report.md",
    ];
    return new Map(
      names.map((n) => [n, readFileSync(join(gw(), n), "utf8")] as const),
    );
  }
  function expectIntact(previous: Map<string, string>): void {
    for (const [name, text] of previous) {
      expect(existsSync(join(gw(), name))).toBe(true);
      expect(readFileSync(join(gw(), name), "utf8")).toBe(text);
    }
  }

  describe("a non-directory .groundwork/headless", () => {
    // GUARD only for the symlink cases (assertNotSymlink already covers them);
    // RED for the regular file, which is not refused before deletion today.
    it.each([["--json"], ["no --json"]])(
      "a regular file is refused before any previous artifact is deleted (%s)",
      (flag) => {
        const previous = previousArtifacts();
        realWriteFileSync(headless(), "i am a file");

        const thrown = attempt(
          flag === "--json" ? [project, "--json"] : [project],
        );

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain(headless());
        expectIntact(previous);
        expect(readFileSync(headless(), "utf8")).toBe("i am a file");
      },
    );

    it.each([["inside"], ["outside"]])(
      "a symlink to a directory %s the project is refused before deletion and nothing is written through it",
      (where) => {
        const previous = previousArtifacts();
        const target =
          where === "inside" ? join(project, "elsewhere") : join(root, "away");
        mkdirSync(target);
        symlinkSync(target, headless());

        expect(attempt([project, "--json"])).toBeInstanceOf(Error);
        expectIntact(previous);
        expect(readdirSync(target)).toEqual([]);
        expect(lstatSync(headless()).isSymbolicLink()).toBe(true);

        expect(attempt([project])).toBeInstanceOf(Error);
        expectIntact(previous);
        expect(readdirSync(target)).toEqual([]);
      },
    );

    it.each([["--json"], ["no --json"]])(
      "a pending.json that is a directory is refused before deletion (%s)",
      (flag) => {
        const previous = previousArtifacts();
        mkdirSync(pendingPath(), { recursive: true });
        realWriteFileSync(join(pendingPath(), "keep.txt"), "mine");

        const thrown = attempt(
          flag === "--json" ? [project, "--json"] : [project],
        );

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain("pending.json");
        expectIntact(previous);
        expect(readFileSync(join(pendingPath(), "keep.txt"), "utf8")).toBe(
          "mine",
        );
      },
    );
  });

  describe("a planted pending.json.tmp", () => {
    it("a regular file is cleared and the --json run succeeds", () => {
      mkdirSync(headless(), { recursive: true });
      realWriteFileSync(tmpPath(), "stale");

      main([project, "--json"], "linux", out);

      expect(existsSync(pendingPath())).toBe(true);
      expect(existsSync(tmpPath())).toBe(false);
    });

    it("a symlink is replaced, never followed: its target is untouched", () => {
      const victim = join(root, "victim.txt");
      realWriteFileSync(victim, "precious");
      mkdirSync(headless(), { recursive: true });
      symlinkSync(victim, tmpPath());

      main([project, "--json"], "linux", out);

      expect(readFileSync(victim, "utf8")).toBe("precious");
      expect(existsSync(pendingPath())).toBe(true);
      expect(lstatSync(pendingPath()).isFile()).toBe(true);
      expect(
        existsSync(tmpPath()) && lstatSync(tmpPath()).isSymbolicLink(),
      ).toBe(false);
    });

    it("a directory is refused up front, naming the .tmp path, before anything is deleted", () => {
      const previous = previousArtifacts();
      mkdirSync(tmpPath(), { recursive: true });
      realWriteFileSync(join(tmpPath(), "keep.txt"), "mine");

      const thrown = attempt([project, "--json"]);

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("pending.json.tmp");
      expectIntact(previous);
      expect(readFileSync(join(tmpPath(), "keep.txt"), "utf8")).toBe("mine");
    });

    it("a plain re-run deletes a leftover pending.json.tmp, then the now-empty headless directory", () => {
      mkdirSync(headless(), { recursive: true });
      realWriteFileSync(tmpPath(), "stale");

      main([project], "linux", out);

      expect(existsSync(tmpPath())).toBe(false);
      expect(existsSync(headless())).toBe(false);
    });
  });

  describe("the headless rmdir race", () => {
    const failRmdir = (code: string) => {
      const error = Object.assign(new Error(`simulated ${code}`), { code });
      rmdirSyncMock.mockImplementation(() => {
        throw error;
      });
      return error;
    };

    it.each([["ENOTEMPTY"], ["ENOENT"]])(
      "%s from rmdir still succeeds and leaves the directory",
      (code) => {
        main([project, "--json"], "linux", out);
        failRmdir(code);

        expect(() => main([project], "linux", out)).not.toThrow();

        expect(existsSync(join(gw(), "inventory.json"))).toBe(true);
        expect(existsSync(pendingPath())).toBe(false);
        expect(existsSync(headless())).toBe(true);
      },
    );

    it("any other code (EACCES) propagates", () => {
      main([project, "--json"], "linux", out);
      const error = failRmdir("EACCES");

      const thrown = attempt([project]);

      expect(thrown).toBeInstanceOf(Error);
      expect(chainOf(thrown)).toContain(error);
    });
  });

  it("re-checks .groundwork/headless after mkdir: a symlink raced in is refused before the tmp file is written", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    mkdirSyncMock.mockImplementation(
      (...args: Parameters<typeof realMkdirSync>) => {
        const result = realMkdirSync(...args);
        if (String(args[0]) === headless()) {
          realRmSync(headless(), { recursive: true, force: true });
          symlinkSync(outside, headless());
        }
        return result;
      },
    );

    const thrown = attempt([project, "--json"]);

    expect(thrown).toBeInstanceOf(Error);
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(gw(), "inventory.json"))).toBe(true);
    expect(
      writeFileSyncMock.mock.calls.some(([path]) =>
        String(path).includes("pending.json"),
      ),
    ).toBe(false);
  });

  it("a rename failure throws the pending.json error with the cause chained, keeps inventory.json and removes the tmp file", () => {
    const failure = new Error("simulated rename failure");
    renameSyncMock.mockImplementation(
      (...args: Parameters<typeof realRenameSync>) => {
        if (String(args[1]).endsWith("pending.json")) throw failure;
        return realRenameSync(...args);
      },
    );

    const thrown = attempt([project, "--json"]);

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("pending.json");
    expect(chainOf(thrown)).toContain(failure);
    expect(existsSync(join(gw(), "inventory.json"))).toBe(true);
    expect(existsSync(tmpPath())).toBe(false);
    expect(existsSync(pendingPath())).toBe(false);
  });
});

describe("assertAdoptWriteScope and pending.json", () => {
  it("accepts .groundwork/headless/pending.json", () => {
    expect(() => {
      assertAdoptWriteScope("/work/app", [PENDING_REL]);
    }).not.toThrow();
  });

  it("still rejects a project file and a lookalike sibling root", () => {
    expect(() => {
      assertAdoptWriteScope("/work/app", ["headless/pending.json"]);
    }).toThrow();
    expect(() => {
      assertAdoptWriteScope("/work/app", [
        ".groundwork-evil/headless/pending.json",
      ]);
    }).toThrow();
  });
});
