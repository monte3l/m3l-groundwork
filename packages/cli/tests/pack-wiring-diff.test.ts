// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * `diffPackWiring(oldManifest, newManifest, projectDir)`: pure comparison of
 * two manifests' `wiring` by item key (`settings:<event>:<command>`,
 * `settingsTopLevel:<key>`, `packageScripts:<name>`, `verifySteps:<id>`).
 * Items are `{ key }`; a removed item carries `removable` and a changed one
 * `applies`: true only when the project's current value deep-equals the OLD
 * manifest's, otherwise false with a `reason`. The project's three JSON
 * files are only read.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assert,
  dictionary,
  property,
  string,
  stringMatching,
} from "fast-check";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { diffPackWiring } from "../src/pack-wiring-diff.js";
import type { PackManifest, PackWiring } from "../src/packs.js";
import { snapshotTree } from "./add-pack-fixtures.js";

function manifest(wiring: Partial<PackWiring>): PackManifest {
  return {
    schemaVersion: 1,
    name: "demo",
    description: "demo pack",
    modes: ["fresh", "adopt"],
    budget: { agents: 0, skills: 0, hooks: 0, workflows: 0, scripts: 0 },
    requires: undefined,
    wiring: { settings: {}, packageScripts: {}, verifySteps: [], ...wiring },
    adoptNotes: undefined,
  };
}

let project: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "wiring-diff-"));
});
afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

function put(path: string, value: unknown): void {
  mkdirSync(dirname(join(project, path)), { recursive: true });
  writeFileSync(join(project, path), JSON.stringify(value, null, 2));
}

const keys = (items: readonly { key: string }[]): string[] =>
  items.map((item) => item.key).sort();

const hook = (command: string, timeout = 10) => ({
  type: "command",
  command,
  timeout,
});

describe("diffPackWiring", () => {
  it("is empty for identical manifests", () => {
    const m = manifest({ packageScripts: { a: "x" } });
    expect(diffPackWiring(m, m, project)).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
  });

  describe("packageScripts", () => {
    it("reports an added script", () => {
      const result = diffPackWiring(
        manifest({}),
        manifest({ packageScripts: { lint: "eslint ." } }),
        project,
      );
      expect(keys(result.added)).toEqual(["packageScripts:lint"]);
      expect(result.removed).toEqual([]);
    });

    it("marks a removed script removable when the project still has the old value", () => {
      put("package.json", { scripts: { lint: "eslint ." } });
      const result = diffPackWiring(
        manifest({ packageScripts: { lint: "eslint ." } }),
        manifest({}),
        project,
      );
      expect(result.removed).toEqual([
        expect.objectContaining({
          key: "packageScripts:lint",
          removable: true,
        }),
      ]);
    });

    it("marks a removed script not removable, with a reason, when the project changed it", () => {
      put("package.json", { scripts: { lint: "eslint . --fix" } });
      const [item] = diffPackWiring(
        manifest({ packageScripts: { lint: "eslint ." } }),
        manifest({}),
        project,
      ).removed;
      expect(item).toMatchObject({
        key: "packageScripts:lint",
        removable: false,
      });
      expect((item as { reason?: string }).reason).toEqual(expect.any(String));
    });

    it("marks a removed script not removable when the project no longer has it", () => {
      put("package.json", { scripts: {} });
      const [item] = diffPackWiring(
        manifest({ packageScripts: { lint: "eslint ." } }),
        manifest({}),
        project,
      ).removed;
      expect(item).toMatchObject({ removable: false });
    });

    it("marks a removed script not removable when package.json is absent", () => {
      const [item] = diffPackWiring(
        manifest({ packageScripts: { lint: "eslint ." } }),
        manifest({}),
        project,
      ).removed;
      expect(item).toMatchObject({ removable: false });
    });

    it("reports a changed script, applying only when the project holds the old value", () => {
      const oldM = manifest({ packageScripts: { lint: "eslint ." } });
      const newM = manifest({ packageScripts: { lint: "eslint --cache ." } });
      put("package.json", { scripts: { lint: "eslint ." } });
      expect(diffPackWiring(oldM, newM, project).changed).toEqual([
        expect.objectContaining({ key: "packageScripts:lint", applies: true }),
      ]);
      put("package.json", { scripts: { lint: "my own" } });
      const [item] = diffPackWiring(oldM, newM, project).changed;
      expect(item).toMatchObject({
        key: "packageScripts:lint",
        applies: false,
      });
      expect((item as { reason?: string }).reason).toEqual(expect.any(String));
    });
  });

  describe("verifySteps", () => {
    const step = (cmd: string[]) => ({
      id: "gate",
      group: "build",
      name: "Gate",
      cmd,
    });

    it("keys steps by id: added, removable removed, changed", () => {
      expect(
        keys(
          diffPackWiring(
            manifest({}),
            manifest({ verifySteps: [step(["a"])] }),
            project,
          ).added,
        ),
      ).toEqual(["verifySteps:gate"]);

      put("bin/lib/verify-steps.packs.json", [step(["a"])]);
      expect(
        diffPackWiring(
          manifest({ verifySteps: [step(["a"])] }),
          manifest({}),
          project,
        ).removed,
      ).toEqual([
        expect.objectContaining({ key: "verifySteps:gate", removable: true }),
      ]);
      expect(
        diffPackWiring(
          manifest({ verifySteps: [step(["a"])] }),
          manifest({ verifySteps: [step(["b"])] }),
          project,
        ).changed,
      ).toEqual([
        expect.objectContaining({ key: "verifySteps:gate", applies: true }),
      ]);
    });

    it("is not removable or applicable when the project's step differs from the old one", () => {
      put("bin/lib/verify-steps.packs.json", [step(["edited"])]);
      expect(
        diffPackWiring(
          manifest({ verifySteps: [step(["a"])] }),
          manifest({}),
          project,
        ).removed[0],
      ).toMatchObject({ removable: false });
      expect(
        diffPackWiring(
          manifest({ verifySteps: [step(["a"])] }),
          manifest({ verifySteps: [step(["b"])] }),
          project,
        ).changed[0],
      ).toMatchObject({ applies: false });
    });
  });

  describe("settings hooks", () => {
    const settingsOf = (command: string, timeout?: number) => ({
      PreToolUse: [{ matcher: "Bash", hooks: [hook(command, timeout ?? 10)] }],
    });
    const projectSettings = (command: string, timeout: number) => ({
      hooks: settingsOf(command, timeout),
    });

    it("keys a hook by event, matcher and command", () => {
      const result = diffPackWiring(
        manifest({}),
        manifest({ settings: settingsOf("node a.mjs") }),
        project,
      );
      expect(keys(result.added)).toEqual([
        "settings:PreToolUse[Bash]:node a.mjs",
      ]);
    });

    it("removable only when the project's hook equals the old one", () => {
      const oldM = manifest({ settings: settingsOf("node a.mjs") });
      put(".claude/settings.json", projectSettings("node a.mjs", 10));
      expect(diffPackWiring(oldM, manifest({}), project).removed).toEqual([
        expect.objectContaining({
          key: "settings:PreToolUse[Bash]:node a.mjs",
          removable: true,
        }),
      ]);
      put(".claude/settings.json", projectSettings("node a.mjs", 99));
      expect(
        diffPackWiring(oldM, manifest({}), project).removed[0],
      ).toMatchObject({ removable: false });
    });

    it("a changed hook (same command, different timeout) applies only on an unedited project", () => {
      const oldM = manifest({ settings: settingsOf("node a.mjs", 10) });
      const newM = manifest({ settings: settingsOf("node a.mjs", 20) });
      put(".claude/settings.json", projectSettings("node a.mjs", 10));
      expect(diffPackWiring(oldM, newM, project).changed).toEqual([
        expect.objectContaining({
          key: "settings:PreToolUse[Bash]:node a.mjs",
          applies: true,
        }),
      ]);
      put(".claude/settings.json", projectSettings("node a.mjs", 15));
      expect(diffPackWiring(oldM, newM, project).changed[0]).toMatchObject({
        applies: false,
      });
    });

    it("a hook whose command changed is one removed and one added", () => {
      const result = diffPackWiring(
        manifest({ settings: settingsOf("node a.mjs") }),
        manifest({ settings: settingsOf("node b.mjs") }),
        project,
      );
      expect(keys(result.removed)).toEqual([
        "settings:PreToolUse[Bash]:node a.mjs",
      ]);
      expect(keys(result.added)).toEqual([
        "settings:PreToolUse[Bash]:node b.mjs",
      ]);
      expect(result.changed).toEqual([]);
    });

    describe("the matcher is part of the key", () => {
      const noMatcher = (command: string) => ({
        PreToolUse: [{ hooks: [hook(command)] }],
      });
      const twoMatchers = (command: string) => ({
        PreToolUse: [
          { matcher: "Bash", hooks: [hook(command)] },
          { matcher: "Edit", hooks: [hook(command)] },
        ],
      });

      it("uses settings:<event>:<command> when the entry has no matcher", () => {
        const result = diffPackWiring(
          manifest({}),
          manifest({ settings: noMatcher("node a.mjs") }),
          project,
        );
        expect(keys(result.added)).toEqual(["settings:PreToolUse:node a.mjs"]);
      });

      it("gives the same command under two matchers two items", () => {
        const result = diffPackWiring(
          manifest({}),
          manifest({ settings: twoMatchers("node a.mjs") }),
          project,
        );
        expect(keys(result.added)).toEqual([
          "settings:PreToolUse[Bash]:node a.mjs",
          "settings:PreToolUse[Edit]:node a.mjs",
        ]);
      });

      it("shows the removal of one matcher variant as removed, and the other as unchanged", () => {
        const result = diffPackWiring(
          manifest({ settings: twoMatchers("node a.mjs") }),
          manifest({
            settings: {
              PreToolUse: [{ matcher: "Bash", hooks: [hook("node a.mjs")] }],
            },
          }),
          project,
        );
        expect(keys(result.removed)).toEqual([
          "settings:PreToolUse[Edit]:node a.mjs",
        ]);
        expect(result.added).toEqual([]);
        expect(result.changed).toEqual([]);
      });

      it("locates a hook by matcher and command: another matcher's entry is neither a match nor an edit", () => {
        // The project holds only the Edit variant, identical to the old one.
        put(".claude/settings.json", {
          hooks: {
            PreToolUse: [{ matcher: "Edit", hooks: [hook("node a.mjs")] }],
          },
        });
        const oldM = manifest({ settings: twoMatchers("node a.mjs") });
        const newM = manifest({ settings: noMatcher("node z.mjs") });
        const removed = diffPackWiring(oldM, newM, project).removed;
        const byKey = new Map(removed.map((item) => [item.key, item]));
        // The Edit variant is the project's own, equal to the old value.
        expect(byKey.get("settings:PreToolUse[Edit]:node a.mjs")).toMatchObject(
          { removable: true },
        );
        // The Bash variant is absent: not "edited" by the Edit entry.
        const bash = byKey.get("settings:PreToolUse[Bash]:node a.mjs");
        expect(bash).toMatchObject({ removable: false });
        expect(bash?.reason).toMatch(/no longer in the project/);
        expect(bash?.reason).not.toMatch(/edited/);
      });
    });
  });

  describe("settingsTopLevel", () => {
    const line = (padding: number) => ({
      statusLine: { type: "command", command: "node s.mjs", padding },
    });

    it("reports added, removable removed and changed top-level keys", () => {
      expect(
        keys(
          diffPackWiring(
            manifest({}),
            manifest({ settingsTopLevel: line(1) }),
            project,
          ).added,
        ),
      ).toEqual(["settingsTopLevel:statusLine"]);

      put(".claude/settings.json", line(1));
      expect(
        diffPackWiring(
          manifest({ settingsTopLevel: line(1) }),
          manifest({}),
          project,
        ).removed,
      ).toEqual([
        expect.objectContaining({
          key: "settingsTopLevel:statusLine",
          removable: true,
        }),
      ]);
      expect(
        diffPackWiring(
          manifest({ settingsTopLevel: line(1) }),
          manifest({ settingsTopLevel: line(2) }),
          project,
        ).changed,
      ).toEqual([
        expect.objectContaining({
          key: "settingsTopLevel:statusLine",
          applies: true,
        }),
      ]);
    });

    it("is not removable when the owner edited the value", () => {
      put(".claude/settings.json", line(7));
      expect(
        diffPackWiring(
          manifest({ settingsTopLevel: line(1) }),
          manifest({}),
          project,
        ).removed[0],
      ).toMatchObject({ removable: false });
    });
  });

  it("never writes anything in the project", () => {
    put("package.json", { scripts: { lint: "x" } });
    const before = snapshotTree(project);
    diffPackWiring(
      manifest({ packageScripts: { lint: "x" } }),
      manifest({ packageScripts: { test: "y" } }),
      project,
    );
    expect(snapshotTree(project)).toEqual(before);
  });
});

describe("diffPackWiring properties", () => {
  const name = stringMatching(/^[a-z][a-z0-9-]{0,8}$/).filter(
    (n) => n !== "constructor" && n !== "prototype",
  );
  const scripts = dictionary(name, string({ maxLength: 12 }), {
    maxKeys: 6,
  });

  it("a manifest against itself has an empty diff", () => {
    assert(
      property(scripts, (a) => {
        const m = manifest({ packageScripts: a });
        const result = diffPackWiring(m, m, project);
        expect(result).toEqual({ added: [], removed: [], changed: [] });
      }),
    );
  });

  it("added keys exist only in the new manifest, removed only in the old, changed in both", () => {
    assert(
      property(scripts, scripts, (a, b) => {
        const result = diffPackWiring(
          manifest({ packageScripts: a }),
          manifest({ packageScripts: b }),
          project,
        );
        const key = (n: string): string => `packageScripts:${n}`;
        expect(keys(result.added)).toEqual(
          Object.keys(b)
            .filter((n) => !(n in a))
            .map(key)
            .sort(),
        );
        expect(keys(result.removed)).toEqual(
          Object.keys(a)
            .filter((n) => !(n in b))
            .map(key)
            .sort(),
        );
        expect(keys(result.changed)).toEqual(
          Object.keys(a)
            .filter((n) => n in b && a[n] !== b[n])
            .map(key)
            .sort(),
        );
      }),
    );
  });
});
