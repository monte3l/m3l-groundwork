// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The guarantees of the /customize skill install's swap (`../src/plugin.ts`,
 * "How a skill file is replaced ..."): a skill file is never missing and
 * never partly written, whichever step an observer looks at, a failure puts
 * the previous files back byte-for-byte, a killed run leaves only complete
 * files and a lock a person can see, and a second run never rolls the first
 * one back.
 *
 * Failures are injected through a `node:fs` mock (the same `vi.hoisted`
 * partial-mock pattern as `plugin-rollback.test.ts`): every function this
 * install mutates through delegates to the real one unless a test layers a
 * hook on top, so the files on disk are always real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type * as NodeFs from "node:fs";
import {
  CUSTOMIZE_SKILL_ENTRY_FILE,
  CUSTOMIZE_SKILL_FILE_NAMES,
  CUSTOMIZE_SKILL_STEP_FILE_NAMES,
  CUSTOMIZE_SKILL_WRITE_ORDER,
} from "../src/customize-paths.js";

type Fn = (...args: unknown[]) => unknown;

const { mocks, real } = vi.hoisted(() => ({
  mocks: {
    renameSync: vi.fn(),
    linkSync: vi.fn(),
    writeFileSync: vi.fn(),
    fsyncSync: vi.fn(),
    rmSync: vi.fn(),
    readFileSync: vi.fn(),
  },
  real: {} as Record<
    | "renameSync"
    | "linkSync"
    | "writeFileSync"
    | "fsyncSync"
    | "rmSync"
    | "readFileSync",
    Fn
  >,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  for (const key of Object.keys(mocks) as (keyof typeof real)[]) {
    real[key] = actual[key] as Fn;
  }
  return { ...actual, ...mocks };
});

const { installCustomizeSkill, installCustomizeSkillGuarded } =
  await import("../src/plugin.js");

type Mocked = keyof typeof mocks;
const MOCKED = Object.keys(mocks) as Mocked[];

/** Every mocked function delegates to the real one. */
function passthrough(): void {
  for (const key of MOCKED) {
    mocks[key].mockReset();
    mocks[key].mockImplementation((...args: unknown[]) => real[key](...args));
  }
}

/** Runs `hook` before each call of `name` (1-based call number), then the real function. The hook may throw. */
function hookCalls(
  name: Mocked,
  hook: (args: unknown[], call: number) => void,
): void {
  let calls = 0;
  mocks[name].mockImplementation((...args: unknown[]) => {
    calls++;
    hook(args, calls);
    return real[name](...args);
  });
}

function errno(code: string, message: string): NodeJS.ErrnoException {
  const failure = new Error(`${code}: ${message} (simulated)`);
  return Object.assign(failure, { code });
}

const NEW_DATA: Record<string, string> = {
  "kind-facet-map.ts": "export const x = 1;\n",
  "domain-map.ts": "export const y = 2;\n",
  "pack-map.ts": "export const z = 3;\n",
  "plugin-map.ts": "export const w = 4;\n",
};

function newContent(name: string): string {
  if (name === CUSTOMIZE_SKILL_ENTRY_FILE) {
    return "---\nname: customize\n---\n# customize\n";
  }
  return NEW_DATA[name] ?? `# ${name}\n`;
}

function oldContent(name: string): string {
  return `OLD ${name}\n`;
}

function writeSourceFixture(sourceDir: string): void {
  mkdirSync(join(sourceDir, "skills", "customize"), { recursive: true });
  mkdirSync(join(sourceDir, "src"), { recursive: true });
  const steps: readonly string[] = CUSTOMIZE_SKILL_STEP_FILE_NAMES;
  for (const name of CUSTOMIZE_SKILL_FILE_NAMES) {
    const dir =
      name === CUSTOMIZE_SKILL_ENTRY_FILE || steps.includes(name)
        ? join(sourceDir, "skills", "customize")
        : join(sourceDir, "src");
    writeFileSync(join(dir, name), newContent(name));
  }
}

/** What each payload name holds in `dir` right now; `undefined` when absent. */
function state(dir: string): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const name of CUSTOMIZE_SKILL_FILE_NAMES) {
    const path = join(dir, name);
    out[name] = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  }
  return out;
}

function expectAll(
  dir: string,
  content: (name: string) => string | undefined,
): void {
  for (const name of CUSTOMIZE_SKILL_FILE_NAMES) {
    expect(state(dir)[name], name).toBe(content(name));
  }
}

/** The directory holds exactly the payload files: no temporary file, no lock. */
function expectNoLeftovers(dir: string): void {
  expect(readdirSync(dir).toSorted()).toEqual(
    [...CUSTOMIZE_SKILL_FILE_NAMES].toSorted(),
  );
}

function writeOld(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const name of CUSTOMIZE_SKILL_FILE_NAMES) {
    writeFileSync(join(dir, name), oldContent(name));
  }
}

function thrownBy(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
  }
  throw new Error("expected the install to throw");
}

let sourceDir: string;
let targetDir: string;

beforeEach(() => {
  passthrough();
  sourceDir = mkdtempSync(join(tmpdir(), "plugin-atomic-src-"));
  targetDir = mkdtempSync(join(tmpdir(), "plugin-atomic-tgt-"));
  writeSourceFixture(sourceDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of [sourceDir, targetDir]) {
    const real_rm = real.rmSync;
    real_rm?.(dir, { recursive: true, force: true });
  }
  for (const key of MOCKED) {
    mocks[key].mockReset();
  }
});

/**
 * The two locations a replacing policy writes: fresh mode's
 * `.claude/skills/customize/` under `--force` ("overwrite") and the
 * CLI-owned `.groundwork/customize/` ("cli-owned", reached through adopt
 * mode's fallback). The same guarantees hold for both.
 */
const REPLACING = [
  {
    label: "fresh --force, .claude/skills/customize",
    segments: [".claude", "skills", "customize"],
    prepare(): void {
      /* the old install is written by the test */
    },
    run: (target: string, source: string) =>
      installCustomizeSkill(target, source),
  },
  {
    label: "adopt fallback, .groundwork/customize",
    segments: [".groundwork", "customize"],
    prepare(target: string): void {
      mkdirSync(join(target, ".claude", "skills", "customize"), {
        recursive: true,
      });
      writeFileSync(
        join(target, ".claude", "skills", "customize", "SKILL.md"),
        "a project-authored skill\n",
      );
    },
    run: (target: string, source: string) =>
      installCustomizeSkillGuarded(target, source),
  },
] as const;

describe.each(REPLACING)("replacing install ($label)", (scenario) => {
  let destDir: string;

  beforeEach(() => {
    scenario.prepare(targetDir);
    destDir = join(targetDir, ...scenario.segments);
    writeOld(destDir);
  });

  it("is, at every fs step, either the complete old or the complete new file: never missing, never truncated", () => {
    const seen: string[] = [];
    const observe = (when: string): void => {
      for (const name of CUSTOMIZE_SKILL_FILE_NAMES) {
        const path = join(destDir, name);
        expect(existsSync(path), `${when}: ${name} is missing`).toBe(true);
        const content = String(real.readFileSync(path, "utf8"));
        expect(
          [oldContent(name), newContent(name)],
          `${when}: ${name} is neither the old nor the new content`,
        ).toContain(content);
      }
      seen.push(when);
    };
    for (const key of MOCKED) {
      mocks[key].mockImplementation((...args: unknown[]) => {
        observe(`before ${key}`);
        const result = real[key](...args);
        observe(`after ${key}`);
        return result;
      });
    }

    scenario.run(targetDir, sourceDir);

    // Observed around every write, fsync, rename and removal.
    expect(seen.length).toBeGreaterThan(CUSTOMIZE_SKILL_FILE_NAMES.length * 4);
    expectAll(destDir, newContent);
    expectNoLeftovers(destDir);
  });

  it("flushes every new file before the first rename, and renames in write order with SKILL.md last", () => {
    const log: string[] = [];
    for (const key of ["fsyncSync", "renameSync"] as const) {
      mocks[key].mockImplementation((...args: unknown[]) => {
        log.push(
          key === "renameSync" ? `rename:${basename(String(args[1]))}` : key,
        );
        return real[key](...args);
      });
    }

    scenario.run(targetDir, sourceDir);

    const renames = log.filter((entry) => entry.startsWith("rename:"));
    expect(renames).toEqual(
      CUSTOMIZE_SKILL_WRITE_ORDER.map((name) => `rename:${name}`),
    );
    const firstRename = log.indexOf(renames[0] ?? "");
    const flushedBefore = log
      .slice(0, firstRename)
      .filter((e) => e === "fsyncSync");
    expect(flushedBefore.length).toBeGreaterThanOrEqual(
      CUSTOMIZE_SKILL_FILE_NAMES.length,
    );
    expect(log.at(-1)).toBe("rename:SKILL.md");
  });

  it.each(CUSTOMIZE_SKILL_WRITE_ORDER.map((name, index) => ({ name, index })))(
    "a failure renaming $name (file $index of 10) puts every previous file back byte-for-byte, and a re-run finishes",
    ({ name, index }) => {
      hookCalls("renameSync", (args) => {
        if (
          String(args[1]) === join(destDir, name) &&
          basename(String(args[0])).includes(".new-")
        ) {
          throw errno("EACCES", "permission denied, rename");
        }
      });

      const error = thrownBy(() => scenario.run(targetDir, sourceDir));

      expect(error.message).toContain("could not install the /customize skill");
      expect(error.message).toContain(
        `could not replace ${join(destDir, name)}`,
      );
      expect(error.message).toContain(
        index === 0
          ? "nothing was replaced"
          : `put back the previous version of ${String(index)} file(s) and removed 0 file(s) this run created`,
      );
      expect((error.cause as NodeJS.ErrnoException).code).toBe("EACCES");
      expectAll(destDir, oldContent);
      expectNoLeftovers(destDir);

      passthrough();
      scenario.run(targetDir, sourceDir);
      expectAll(destDir, newContent);
      expectNoLeftovers(destDir);
    },
  );

  it.each([0, 1, 9])(
    "a failure while staging file %i (a full disk part-way through its content) has replaced nothing and leaves no temporary file",
    (failAt) => {
      let staged = 0;
      hookCalls("writeFileSync", (args) => {
        if (Buffer.isBuffer(args[1]) && ++staged === failAt + 1) {
          real.writeFileSync(args[0], "PARTIAL");
          throw errno("ENOSPC", "no space left on device");
        }
      });

      const error = thrownBy(() => scenario.run(targetDir, sourceDir));

      expect(error.message).toContain("could not stage the new copy");
      expect(error.message).toContain("nothing was replaced");
      expect(error.message).not.toContain("NOT restored");
      expectAll(destDir, oldContent);
      expectNoLeftovers(destDir);

      passthrough();
      scenario.run(targetDir, sourceDir);
      expectAll(destDir, newContent);
    },
  );

  it("a file that cannot be put back is named, still holds its complete new content, and a re-run finishes the install", () => {
    const skill = join(destDir, "SKILL.md");
    const data = join(destDir, "domain-map.ts");
    hookCalls("renameSync", (args) => {
      // Fail the LAST new file, then make restoring domain-map.ts fail too.
      if (String(args[1]) === skill && String(args[0]).includes(".new-")) {
        throw errno("EIO", "i/o error, rename");
      }
      if (String(args[1]) === data && String(args[0]).includes(".old-")) {
        throw errno("EBUSY", "resource busy, rename");
      }
    });

    const error = thrownBy(() => scenario.run(targetDir, sourceDir));

    expect(error.message).toContain(`could not undo: ${data} (EBUSY)`);
    expect(error.message).toContain("still holds the new, complete copy");
    expect(error.message).toContain(
      "put back the previous version of 8 file(s)",
    );
    // Every other file is old; the one that could not be put back is new and whole.
    for (const name of CUSTOMIZE_SKILL_FILE_NAMES) {
      expect(state(destDir)[name], name).toBe(
        name === "domain-map.ts" ? newContent(name) : oldContent(name),
      );
    }
    expect(readdirSync(destDir)).not.toContain(".install.lock");

    passthrough();
    scenario.run(targetDir, sourceDir);
    expectAll(destDir, newContent);
    expectNoLeftovers(destDir);
  });

  it("restores the previous file with its own mode when the failure comes after it was replaced", () => {
    if (process.platform === "win32") {
      return;
    }
    chmodSync(join(destDir, "pack-map.ts"), 0o640);
    hookCalls("renameSync", (args) => {
      if (
        String(args[1]) === join(destDir, "SKILL.md") &&
        String(args[0]).includes(".new-")
      ) {
        throw errno("EACCES", "permission denied, rename");
      }
    });

    thrownBy(() => scenario.run(targetDir, sourceDir));

    expect(statSync(join(destDir, "pack-map.ts")).mode & 0o777).toBe(0o640);
    expect(readFileSync(join(destDir, "pack-map.ts"), "utf8")).toBe(
      oldContent("pack-map.ts"),
    );
  });

  it("restores byte-for-byte through a copy too when the filesystem cannot hard-link the previous file", () => {
    mocks.linkSync.mockImplementation(() => {
      throw errno("EPERM", "operation not permitted, link");
    });
    hookCalls("renameSync", (args) => {
      if (
        String(args[1]) === join(destDir, "SKILL.md") &&
        String(args[0]).includes(".new-")
      ) {
        throw errno("EACCES", "permission denied, rename");
      }
    });

    thrownBy(() => scenario.run(targetDir, sourceDir));

    expectAll(destDir, oldContent);
    expectNoLeftovers(destDir);
  });

  it("refuses up front, replacing nothing, a previous file it can neither hard-link nor read", () => {
    const target = join(destDir, "domain-map.ts");
    mocks.linkSync.mockImplementation(() => {
      throw errno("EPERM", "operation not permitted, link");
    });
    hookCalls("readFileSync", (args) => {
      if (String(args[0]) === target) {
        throw errno("EACCES", "permission denied, open");
      }
    });

    const error = thrownBy(() => scenario.run(targetDir, sourceDir));

    passthrough();
    expect(error.message).toContain(`could not read ${target}`);
    expect(error.message).toContain("nothing was replaced");
    expectAll(destDir, oldContent);
    expectNoLeftovers(destDir);
  });

  it("puts a replaced symlink back as the same symlink, and never writes through it", () => {
    if (process.platform === "win32") {
      return;
    }
    const outside = join(targetDir, "outside.txt");
    writeFileSync(outside, "OUTSIDE\n");
    const link = join(destDir, "kind-facet-map.ts");
    real.rmSync(link);
    symlinkSync(outside, link);
    hookCalls("renameSync", (args) => {
      if (
        String(args[1]) === join(destDir, "SKILL.md") &&
        String(args[0]).includes(".new-")
      ) {
        throw errno("EACCES", "permission denied, rename");
      }
    });

    thrownBy(() => scenario.run(targetDir, sourceDir));

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(outside);
    expect(readFileSync(outside, "utf8")).toBe("OUTSIDE\n");

    passthrough();
    scenario.run(targetDir, sourceDir);
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(readFileSync(link, "utf8")).toBe(newContent("kind-facet-map.ts"));
    expect(readFileSync(outside, "utf8")).toBe("OUTSIDE\n");
  });

  it.skipIf(process.platform === "win32")(
    "refuses a FIFO at a payload name (which it could not put back) before replacing anything",
    () => {
      const fifo = join(destDir, "pack-map.ts");
      real.rmSync(fifo);
      execFileSync("mkfifo", [fifo]);

      const error = thrownBy(() => scenario.run(targetDir, sourceDir));

      expect(error.message).toContain("neither a file nor a symlink");
      expect(error.message).toContain("nothing was removed or written");
      expect(readFileSync(join(destDir, "SKILL.md"), "utf8")).toBe(
        oldContent("SKILL.md"),
      );
    },
  );

  describe("a run that dies part-way (simulated: every later fs call fails, so no cleanup or undo runs)", () => {
    /** Lets `survive` calls of `fn` succeed, then fails that call and everything after it, for every mutating function. */
    function dieAfter(fn: Mocked, survive: number): void {
      let calls = 0;
      let dead = false;
      for (const key of MOCKED) {
        if (key === "readFileSync") {
          continue;
        }
        mocks[key].mockImplementation((...args: unknown[]) => {
          if (key === fn) {
            calls++;
            if (calls > survive) {
              dead = true;
            }
          }
          if (dead) {
            throw errno("EIO", "the process died");
          }
          return real[key](...args);
        });
      }
    }

    beforeEach(() => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    it.each([0, 1, 4, 8, 9])(
      "after %i renames every file is complete (old or new, never missing or truncated), SKILL.md is new only after all the others, and a re-run converges once the lock is cleared",
      (survive) => {
        dieAfter("renameSync", survive);

        thrownBy(() => scenario.run(targetDir, sourceDir));
        passthrough();

        const now = state(destDir);
        for (const name of CUSTOMIZE_SKILL_FILE_NAMES) {
          expect([oldContent(name), newContent(name)], name).toContain(
            now[name],
          );
        }
        const renamed = CUSTOMIZE_SKILL_WRITE_ORDER.slice(0, survive);
        for (const name of CUSTOMIZE_SKILL_WRITE_ORDER) {
          expect(now[name], name).toBe(
            renamed.includes(name) ? newContent(name) : oldContent(name),
          );
        }
        // The dead run's lock and temporary files are visible, never hidden.
        expect(readdirSync(destDir)).toContain(".install.lock");

        // A re-run refuses to guess whether the owner is gone ...
        const blocked = thrownBy(() => scenario.run(targetDir, sourceDir));
        expect(blocked.message).toContain(".install.lock exists");
        expect(blocked.message).toContain("delete");
        expect(state(destDir)).toEqual(now);
        // ... and once the lock is deleted it finishes the install and sweeps the leftovers.
        real.rmSync(join(destDir, ".install.lock"));
        scenario.run(targetDir, sourceDir);
        expectAll(destDir, newContent);
        expectNoLeftovers(destDir);
      },
    );

    it("a death while staging leaves the whole old skill in place", () => {
      dieAfter("fsyncSync", 3);

      thrownBy(() => scenario.run(targetDir, sourceDir));
      passthrough();

      expectAll(destDir, oldContent);
      real.rmSync(join(destDir, ".install.lock"));
      scenario.run(targetDir, sourceDir);
      expectAll(destDir, newContent);
      expectNoLeftovers(destDir);
    });
  });

  describe("a second run while the first is running", () => {
    it("is refused by the lock, changes nothing, and the first run completes", () => {
      let inner: Error | undefined;
      let seenDuringSwap: Record<string, string | undefined> = {};
      hookCalls("renameSync", (_args, call) => {
        if (call === 3) {
          seenDuringSwap = state(destDir);
          inner = thrownBy(() => scenario.run(targetDir, sourceDir));
        }
      });

      scenario.run(targetDir, sourceDir);

      expect(inner?.message).toContain(".install.lock exists");
      expect(inner?.message).toContain("another install is running");
      expect(state(destDir)).not.toEqual(seenDuringSwap);
      expectAll(destDir, newContent);
      expectNoLeftovers(destDir);
    });

    it("never has its rollback undone by, nor undoes, the other run: the lock is released after a failure", () => {
      hookCalls("renameSync", (args) => {
        if (
          String(args[1]) === join(destDir, "SKILL.md") &&
          String(args[0]).includes(".new-")
        ) {
          throw errno("EACCES", "permission denied, rename");
        }
      });

      thrownBy(() => scenario.run(targetDir, sourceDir));

      expect(readdirSync(destDir)).not.toContain(".install.lock");
    });
  });

  describe("error wording", () => {
    it("ends once with this mode's advice and states the guarantee instead of the old remove-then-write window", () => {
      hookCalls("renameSync", (args) => {
        if (
          String(args[1]) === join(destDir, "domain-map.ts") &&
          String(args[0]).includes(".new-")
        ) {
          throw errno("EACCES", "permission denied, rename");
        }
      });

      const { message } = thrownBy(() => scenario.run(targetDir, sourceDir));

      const prefix = "could not install the /customize skill:";
      expect(message.split(prefix).length - 1).toBe(1);
      for (const retired of [
        "NOT restored",
        "not loadable",
        "truncated",
        "removed before",
        "whether this run created it is unknown",
      ]) {
        expect(message).not.toContain(retired);
      }
      if (scenario.segments[0] === ".claude") {
        expect(
          message.endsWith("retry the same command with --fresh --force added"),
        ).toBe(true);
        expect(message).not.toContain("re-run the CLI");
      } else {
        expect(message).toContain("fell back to .groundwork/customize/");
        expect(message.endsWith("fix the cause and re-run the CLI")).toBe(true);
        expect(message).not.toContain("--fresh --force");
      }
    });

    it("normalizes a non-Error thrown value and keeps the raw value as cause", () => {
      hookCalls("renameSync", (args) => {
        if (String(args[1]) === join(destDir, "kind-facet-map.ts")) {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error throw to verify installError's String(cause) normalization
          throw "disk full (simulated)";
        }
      });

      const error = thrownBy(() => scenario.run(targetDir, sourceDir));

      expect(error.message).toContain("disk full (simulated)");
      expect(error.cause).toBe("disk full (simulated)");
      expect(error.message).toContain("nothing was replaced");
    });
  });
});

describe("replacing install into an empty destination (nothing previous to put back)", () => {
  const destSegments = [".claude", "skills", "customize"];

  it.each([0, 3, 9])(
    "a failure renaming file %i removes the files this run created and leaves the destination empty",
    (index) => {
      const destDir = join(targetDir, ...destSegments);
      const name = CUSTOMIZE_SKILL_WRITE_ORDER[index] ?? "";
      hookCalls("renameSync", (args) => {
        if (String(args[1]) === join(destDir, name)) {
          throw errno("EACCES", "permission denied, rename");
        }
      });

      const error = thrownBy(() => installCustomizeSkill(targetDir, sourceDir));

      expect(error.message).toContain(
        index === 0
          ? "nothing was replaced"
          : `removed ${String(index)} file(s) this run created`,
      );
      expect(readdirSync(destDir)).toEqual([]);

      passthrough();
      expect(
        installCustomizeSkill(targetDir, sourceDir).filesWritten,
      ).toHaveLength(CUSTOMIZE_SKILL_FILE_NAMES.length);
    },
  );

  it("keeps a project's own unrelated file in the directory, whatever happens", () => {
    const destDir = join(targetDir, ...destSegments);
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, "project-owned.txt"), "mine\n");
    hookCalls("renameSync", (args) => {
      if (String(args[1]) === join(destDir, "domain-map.ts")) {
        throw errno("EACCES", "permission denied, rename");
      }
    });

    thrownBy(() => installCustomizeSkill(targetDir, sourceDir));

    expect(readdirSync(destDir)).toEqual(["project-owned.txt"]);
  });
});

describe("the CLI-owned .groundwork/customize/ replaces whatever sits at a payload name", () => {
  it("replaces an entry that appears mid-install (it is the CLI's own directory, never a project's)", () => {
    mkdirSync(join(targetDir, ".claude", "skills", "customize"), {
      recursive: true,
    });
    writeFileSync(
      join(targetDir, ".claude", "skills", "customize", "SKILL.md"),
      "a project-authored skill\n",
    );
    const destDir = join(targetDir, ".groundwork", "customize");
    const raced = join(destDir, "domain-map.ts");
    hookCalls("renameSync", (_args, call) => {
      if (call === 1) {
        real.writeFileSync(raced, "// stale groundwork content\n");
      }
    });

    const result = installCustomizeSkillGuarded(targetDir, sourceDir);

    expect(result.location).toBe("groundwork");
    expect(result.filesWritten).toHaveLength(CUSTOMIZE_SKILL_FILE_NAMES.length);
    expect(readFileSync(raced, "utf8")).toBe(newContent("domain-map.ts"));
    expect(
      readFileSync(
        join(targetDir, ".claude", "skills", "customize", "SKILL.md"),
        "utf8",
      ),
    ).toBe("a project-authored skill\n");
  });
});

describe("adopt mode's additive install into .claude/skills/customize/", () => {
  let destDir: string;

  beforeEach(() => {
    destDir = join(targetDir, ".claude", "skills", "customize");
  });

  it("makes every file appear complete or not at all, at every fs step", () => {
    const observe = (when: string): void => {
      for (const name of CUSTOMIZE_SKILL_FILE_NAMES) {
        const path = join(destDir, name);
        if (existsSync(path)) {
          expect(real.readFileSync(path, "utf8"), `${when}: ${name}`).toBe(
            newContent(name),
          );
        }
      }
    };
    for (const key of MOCKED) {
      mocks[key].mockImplementation((...args: unknown[]) => {
        observe(`before ${key}`);
        const result = real[key](...args);
        observe(`after ${key}`);
        return result;
      });
    }

    const result = installCustomizeSkillGuarded(targetDir, sourceDir);

    expect(result.location).toBe("claude");
    expectAll(destDir, newContent);
    expectNoLeftovers(destDir);
  });

  it("links the flushed temporary file into place, so SKILL.md is last and exclusive", () => {
    const log: string[] = [];
    for (const key of ["fsyncSync", "linkSync"] as const) {
      mocks[key].mockImplementation((...args: unknown[]) => {
        log.push(
          key === "linkSync" ? `link:${basename(String(args[1]))}` : key,
        );
        return real[key](...args);
      });
    }

    installCustomizeSkillGuarded(targetDir, sourceDir);

    expect(log.filter((e) => e.startsWith("link:"))).toEqual(
      CUSTOMIZE_SKILL_WRITE_ORDER.map((name) => `link:${name}`),
    );
    // Each file is flushed before it is linked.
    expect(log.slice(0, 2)).toEqual(["fsyncSync", "link:kind-facet-map.ts"]);
  });

  it.each([0, 1, 9])(
    "a failure writing file %i (a full disk part-way) removes what this run created and nothing else, and a re-run finishes",
    (failAt) => {
      mkdirSync(destDir, { recursive: true });
      let staged = 0;
      hookCalls("writeFileSync", (args) => {
        if (Buffer.isBuffer(args[1]) && ++staged === failAt + 1) {
          real.writeFileSync(args[0], "PARTIAL");
          throw errno("ENOSPC", "no space left on device");
        }
      });

      const error = thrownBy(() =>
        installCustomizeSkillGuarded(targetDir, sourceDir),
      );

      expect(error.message).toContain(
        `removed the ${String(failAt)} file(s) written by this run`,
      );
      expect(readdirSync(destDir)).toEqual([]);

      passthrough();
      const result = installCustomizeSkillGuarded(targetDir, sourceDir);
      expect(result.filesWritten).toHaveLength(
        CUSTOMIZE_SKILL_FILE_NAMES.length,
      );
      expectAll(destDir, newContent);
    },
  );

  it("fails EEXIST on an entry that appears mid-install, leaves it untouched, and removes only what this run created", () => {
    const raced = join(destDir, "domain-map.ts");
    const content = "// RACED-IN PROJECT CONTENT, not created by this call\n";
    hookCalls("linkSync", (args) => {
      if (String(args[1]) === raced) {
        real.writeFileSync(raced, content);
      }
    });

    const error = thrownBy(() =>
      installCustomizeSkillGuarded(targetDir, sourceDir),
    );

    expect(error.message).toContain("appeared during the install");
    expect((error.cause as NodeJS.ErrnoException).code).toBe("EEXIST");
    expect(readFileSync(raced, "utf8")).toBe(content);
    expect(readdirSync(destDir)).toEqual(["domain-map.ts"]);
  });

  it("says so when the filesystem cannot make the hard link it needs", () => {
    mocks.linkSync.mockImplementation(() => {
      throw errno("EPERM", "operation not permitted, link");
    });

    const error = thrownBy(() =>
      installCustomizeSkillGuarded(targetDir, sourceDir),
    );

    expect(error.message).toContain("may not support hard links");
    expect(readdirSync(destDir)).toEqual([]);
  });

  it("a file this run could not remove during its rollback is named with its code", () => {
    const first = join(destDir, "kind-facet-map.ts");
    hookCalls("linkSync", (args) => {
      if (String(args[1]) === join(destDir, "pack-map.ts")) {
        throw errno("EACCES", "permission denied, link");
      }
    });
    mocks.rmSync.mockImplementation((...args: unknown[]) => {
      if (String(args[0]) === first) {
        throw errno("EBUSY", "resource busy, unlink");
      }
      return real.rmSync(...args);
    });

    const error = thrownBy(() =>
      installCustomizeSkillGuarded(targetDir, sourceDir),
    );

    expect(error.message).toContain(`could not remove: ${first} (EBUSY)`);
    expect(error.message).toContain(
      "removed the 1 file(s) written by this run",
    );
    expect(existsSync(first)).toBe(true);
  });

  it("fails and rolls back with this mode's advice when the SKILL.md write is the one that fails", () => {
    mkdirSync(destDir, { recursive: true });
    for (const name of CUSTOMIZE_SKILL_WRITE_ORDER.slice(0, -1)) {
      writeFileSync(join(destDir, name), newContent(name));
    }
    hookCalls("linkSync", (args) => {
      if (String(args[1]) === join(destDir, "SKILL.md")) {
        throw errno("EACCES", "permission denied, link");
      }
    });

    const error = thrownBy(() =>
      installCustomizeSkillGuarded(targetDir, sourceDir),
    );

    expect(error.message).toContain("fix the cause and re-run the CLI");
    expect(error.message).not.toContain("--fresh --force");
    expect(existsSync(join(destDir, "SKILL.md"))).toBe(false);
    for (const name of CUSTOMIZE_SKILL_WRITE_ORDER.slice(0, -1)) {
      expect(readFileSync(join(destDir, name), "utf8")).toBe(newContent(name));
    }
  });
});

describe("the install lock", () => {
  it("is refused with the lock named, and nothing touched, when one is already held in the fresh destination", () => {
    const destDir = join(targetDir, ".claude", "skills", "customize");
    writeOld(destDir);
    writeFileSync(join(destDir, ".install.lock"), "99999\n");

    const error = thrownBy(() => installCustomizeSkill(targetDir, sourceDir));

    expect(error.message).toContain(`${join(destDir, ".install.lock")} exists`);
    expect(error.message).toContain("nothing was removed or written");
    expectAll(destDir, oldContent);
    expect(readFileSync(join(destDir, ".install.lock"), "utf8")).toBe(
      "99999\n",
    );
  });

  it("is never created, in the project-owned adopt location, by the additive install", () => {
    const seen: string[] = [];
    mocks.linkSync.mockImplementation((...args: unknown[]) => {
      seen.push(
        ...readdirSync(join(targetDir, ".claude", "skills", "customize")),
      );
      return real.linkSync(...args);
    });

    installCustomizeSkillGuarded(targetDir, sourceDir);

    expect(seen).not.toContain(".install.lock");
  });
});

describe("a dead run's temporary files", () => {
  it("are swept by the next replacing install, and a project's own dot files are not", () => {
    const destDir = join(targetDir, ".claude", "skills", "customize");
    writeOld(destDir);
    const leftovers = [
      ".SKILL.md.new-4242-deadbeef.tmp",
      ".domain-map.ts.old-4242-0badf00d.tmp",
    ];
    for (const name of [...leftovers, ".my-notes.tmp", ".gitkeep"]) {
      writeFileSync(join(destDir, name), "x");
    }

    installCustomizeSkill(targetDir, sourceDir);

    for (const name of leftovers) {
      expect(existsSync(join(destDir, name))).toBe(false);
    }
    expect(readdirSync(destDir).toSorted()).toEqual(
      [...CUSTOMIZE_SKILL_FILE_NAMES, ".gitkeep", ".my-notes.tmp"].toSorted(),
    );
  });
});

describe("remediation is appended by end-anchor, not by substring", () => {
  it("still appends fresh mode's advice when the target path's own text contains 're-run the CLI'", () => {
    const odd = mkdtempSync(join(tmpdir(), "re-run the CLI-plugin-atomic-"));
    try {
      hookCalls("renameSync", (args) => {
        if (String(args[1]).endsWith("kind-facet-map.ts")) {
          throw errno("EACCES", "permission denied, rename");
        }
      });

      const { message } = thrownBy(() => installCustomizeSkill(odd, sourceDir));

      expect(message).toContain(odd);
      expect(message).toContain("--fresh --force");
    } finally {
      real.rmSync(odd, { recursive: true, force: true });
    }
  });
});
