// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Shared fixture for the `headless/apply.ts` test files that go beyond
 * `headless-apply.test.ts`: a temp project with its staging helpers, and a
 * hand-written apply journal (the on-disk shape `apply-journal.ts` writes),
 * so a leftover from a crashed run can be set up deterministically.
 */
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
import { expect } from "vitest";
import type { AdoptPlanResult } from "../src/headless/actions.js";
import { ApplyError } from "../src/headless/errors.js";
import { serializeJournal } from "../src/headless/internal/apply-journal.js";
import type { JournalStep } from "../src/headless/internal/apply-journal.js";
import { sha256Hex } from "../src/manifest.js";

export type Action = Extract<AdoptPlanResult, { ok: true }>["actions"][number];
export type Install = Extract<
  Action,
  { kind: "install-staged" | "take-divergent" }
>;
export type Take = Install;
export type Merge = Extract<Action, { kind: "merge-keys" }>;

export const DIVERGENT = ".groundwork/baseline-divergent";
export const BASELINE = ".groundwork/baseline";

/** One temp project and the helpers bound to it; `dispose` removes every dir it made. */
export interface Env {
  readonly root: string;
  readonly abs: (rel: string, base?: string) => string;
  readonly put: (rel: string, data: string | Buffer, base?: string) => void;
  readonly read: (rel: string, base?: string) => Buffer;
  readonly headless: (name: string) => string;
  readonly extraDir: () => string;
  readonly install: (rel: string, data: string | Buffer) => Install;
  readonly take: (rel: string, data: string | Buffer) => Take;
  readonly merge: (rel: string, data: string, takeKeys: string[]) => Merge;
  /** Writes `txn/journal.json` for `steps` (and `txn/backup/<name>` for each `backups` entry). */
  readonly writeJournal: (
    steps: readonly JournalStep[],
    backups?: Readonly<Record<string, string | Buffer>>,
  ) => void;
  readonly noResidue: () => void;
  readonly dispose: () => void;
}

export function makeEnv(): Env {
  const made: string[] = [];
  const fresh = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "hl-apply-x-"));
    made.push(dir);
    return dir;
  };
  const root = fresh();
  mkdirSync(join(root, ".groundwork", "headless"), { recursive: true });
  const abs = (rel: string, base = root): string => join(base, rel);
  const put = (rel: string, data: string | Buffer, base = root): void => {
    mkdirSync(dirname(abs(rel, base)), { recursive: true });
    writeFileSync(abs(rel, base), data);
  };
  const headless = (name: string): string =>
    abs(`.groundwork/headless/${name}`);
  const stage = (
    rel: string,
    data: string | Buffer,
    dir: string,
  ): { stagedPath: string; sha256: string } => {
    const stagedPath = `${dir}/${rel}.staged`;
    put(stagedPath, data);
    return { stagedPath, sha256: sha256Hex(Buffer.from(data)) };
  };
  return {
    root,
    abs,
    put,
    read: (rel, base = root) => readFileSync(abs(rel, base)),
    headless,
    extraDir: fresh,
    install: (rel, data) => ({
      kind: "install-staged",
      path: rel,
      ...stage(rel, data, BASELINE),
    }),
    take: (rel, data) => ({
      kind: "take-divergent",
      path: rel,
      ...stage(rel, data, DIVERGENT),
    }),
    merge: (rel, data, takeKeys) => ({
      kind: "merge-keys",
      path: rel,
      ...stage(rel, data, DIVERGENT),
      takeKeys,
    }),
    writeJournal: (steps, backups = {}) => {
      put(".groundwork/headless/txn/journal.json", serializeJournal(steps));
      for (const [name, data] of Object.entries(backups)) {
        put(`.groundwork/headless/txn/backup/${name}`, data);
      }
    },
    noResidue: () => {
      expect(existsSync(headless("lock"))).toBe(false);
      expect(existsSync(headless("txn"))).toBe(false);
      expect(existsSync(headless("applied.json"))).toBe(false);
    },
    dispose: () => {
      for (const dir of made.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** Awaits a rejection and asserts it is an {@link ApplyError}. */
export async function failure(promise: Promise<unknown>): Promise<ApplyError> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ApplyError);
  return thrown as ApplyError;
}

/** A journal step for a replaced file (`take-divergent`). */
export function replaceStep(
  path: string,
  original: string,
  after: string,
  mode = 0o644,
): JournalStep {
  return {
    kind: "take-divergent",
    path,
    sha256After: sha256Hex(after),
    before: { sha256: sha256Hex(original), mode, backup: "0" },
    createdDirs: [],
  };
}

/** A journal step for a created file (`install-staged`). */
export function installStep(
  path: string,
  after: string,
  createdDirs: string[] = [],
): JournalStep {
  return {
    kind: "install-staged",
    path,
    sha256After: sha256Hex(after),
    before: null,
    createdDirs,
  };
}
