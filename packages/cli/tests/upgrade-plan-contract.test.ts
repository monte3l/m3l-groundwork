// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Round-3 contract of the upgrade plan: token validation, pack order,
 * computePlan's preconditions and its refusal of non-object or
 * stack-overflowing JSON. A small fixture release keeps each case readable.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/manifest.js";
import type { Manifest } from "../src/manifest.js";
import { computePlan, renderRelease } from "../src/upgrade/plan.js";
import type { RenderedRelease } from "../src/upgrade/plan.js";
import { buildProject, writeRelease } from "./upgrade-plan-fixture.js";
import type { FixtureRelease, WrittenRelease } from "./upgrade-plan-fixture.js";

const TOKENS = { PROJECT_NAME: "acme", YEAR: "1999" };
const hj = (value: unknown): string => sha256Hex(JSON.stringify(value));
const hookOf = (command: string): object => ({ type: "command", command });

const RELEASE: FixtureRelease = {
  core: {
    "package.json": '{"name":"__PROJECT_NAME__","scripts":{"lint":"x"}}\n',
    "tsconfig.build.json": "[]\n",
    ".claude/settings.json": '{"env":{}}\n',
    "a.txt": "a\n",
  },
  packs: {
    a: {
      files: { "pa.txt": "a\n" },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [hookOf("cmd-a")] }] },
    },
    b: {
      files: { "pb.txt": "b\n" },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [hookOf("cmd-b")] }] },
    },
  },
};

function catching(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("upgrade plan contract", () => {
  let base: string;
  let project: string;
  let tmpRoot: string;
  let written: WrittenRelease;
  let manifest: Manifest;
  let rendered: RenderedRelease | undefined;

  const render = (
    m: Manifest = manifest,
    version = "2.0.0",
  ): RenderedRelease => {
    rendered = renderRelease({
      manifest: m,
      cliVersion: version,
      templatesDir: written.templatesDir,
      packsRoot: written.packsRoot,
      tmpRoot,
    });
    return rendered;
  };
  const plan = (release: RenderedRelease, m: Manifest = manifest) =>
    computePlan({
      targetDir: project,
      manifest: m,
      release,
      cliVersion: "2.0.0",
    });

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "upgrade-plan-contract-"));
    project = join(base, "project");
    tmpRoot = join(base, "tmp");
    mkdirSync(tmpRoot);
    written = writeRelease(join(base, "rel"), RELEASE);
    manifest = buildProject({
      written,
      packNames: ["a", "b"],
      targetDir: project,
      tokens: TOKENS,
      cliVersion: "1.0.0",
    });
    rendered = undefined;
  });

  afterEach(() => {
    rendered?.dispose();
    rmSync(base, { recursive: true, force: true });
  });

  describe("token validation", () => {
    const SECRET_VALUE = "tok-value-must-not-leak";
    it.each<[string, Record<string, string>, string]>([
      ["a missing PROJECT_NAME", { YEAR: "1999" }, "PROJECT_NAME"],
      ["a missing YEAR", { PROJECT_NAME: "acme" }, "YEAR"],
      [
        "an extra key",
        { PROJECT_NAME: "acme", YEAR: "1999", FOO: SECRET_VALUE },
        "FOO",
      ],
      ["an empty YEAR", { PROJECT_NAME: "acme", YEAR: "" }, "YEAR"],
      [
        "an empty PROJECT_NAME",
        { PROJECT_NAME: "", YEAR: "1999" },
        "PROJECT_NAME",
      ],
    ])(
      "refuses %s, naming the key and no value, before creating anything",
      (_name, tokens, key) => {
        const thrown = catching(() => render({ ...manifest, tokens }));

        expect(thrown).toBeInstanceOf(Error);
        const message = (thrown as Error).message;
        expect(message).toContain(key);
        expect(message).not.toContain(SECRET_VALUE);
        expect(message).not.toContain("acme");
        expect(message).not.toContain("1999");
        expect(readdirSync(tmpRoot)).toEqual([]);
      },
    );
  });

  describe("pack order and duplicates", () => {
    const EXPECTED_HOOKS = [
      {
        hooks: [
          { command: "cmd-a", type: "command" },
          { command: "cmd-b", type: "command" },
        ],
        matcher: "Bash",
      },
    ];

    it.each<[string[]]>([[["b", "a"]], [["a", "b"]], [["b", "a", "b"]]])(
      "renders packs %j in sorted, de-duplicated order; the sorted-built project is all current",
      (packs) => {
        const damaged: Manifest = { ...manifest, packs };

        const release = render(damaged);
        const result = plan(release, damaged);

        expect(
          release.manifest.jsonKeys[".claude/settings.json"]?.[
            "/hooks/PreToolUse"
          ],
        ).toBe(hj(EXPECTED_HOOKS));
        expect(release.manifest.files).toEqual(manifest.files);
        expect(release.manifest.jsonKeys).toEqual(manifest.jsonKeys);
        expect(result.files.filter((e) => e.class !== "current")).toEqual([]);
        expect(
          Object.values(result.jsonKeys)
            .flat()
            .filter((e) => e.class !== "current"),
        ).toEqual([]);
        expect(result.packs).toEqual(["a", "b"]);
      },
    );
  });

  describe("computePlan preconditions", () => {
    it.each(["missing", "file"])(
      "requires targetDir to be a real directory (%s)",
      (kind) => {
        const release = render();
        const bad = join(base, "no-such-project");
        if (kind === "file") writeFileSync(bad, "x");

        const thrown = catching(() =>
          computePlan({
            targetDir: bad,
            manifest,
            release,
            cliVersion: "2.0.0",
          }),
        );

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain(bad);
      },
    );

    it("refuses a release rendered for another CLI version", () => {
      const release = render();

      const thrown = catching(() =>
        computePlan({
          targetDir: project,
          manifest,
          release,
          cliVersion: "3.0.0",
        }),
      );

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/version/i);
      expect((thrown as Error).message).toContain("3.0.0");
    });

    it("refuses a release rendered with other tokens than the manifest's", () => {
      const release = render({
        ...manifest,
        tokens: { PROJECT_NAME: "acme", YEAR: "2000" },
      });

      const thrown = catching(() => plan(release));

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/tokens/i);
    });

    it("refuses a release rendered with other packs than the manifest's", () => {
      const release = render({ ...manifest, packs: ["a"] });

      const thrown = catching(() => plan(release));

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/packs?/i);
    });

    it("takes toCliVersion and a sorted, de-duplicated packs list from the release", () => {
      const release = render();

      const result = plan(release, { ...manifest, packs: ["b", "a", "b"] });

      expect(result.toCliVersion).toBe("2.0.0");
      expect(result.packs).toEqual(["a", "b"]);
    });
  });

  describe("current JSON file shape", () => {
    it.each([
      ["an array", "[1]"],
      ["a string", '"secret-shaped-text"'],
      ["a number", "42"],
      ["a boolean", "true"],
      ["null", "null"],
    ])("refuses %s where package.json is expected", (_name, text) => {
      writeFileSync(join(project, "package.json"), text);
      const release = render();

      const thrown = catching(() => plan(release));

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("package.json");
      expect((thrown as Error).message).not.toContain("secret-shaped-text");
      expect((thrown as Error).cause).toBeUndefined();
    });

    it("never parses a file that has no recorded or next JSON keys", () => {
      writeFileSync(join(project, "tsconfig.build.json"), "not json {{ at all");
      const release = render();

      const result = plan(release);

      expect(
        result.files.find((e) => e.path === "tsconfig.build.json")?.class,
      ).toBe("local-only");
      expect(Object.hasOwn(result.jsonKeys, "tsconfig.build.json")).toBe(false);
    });

    it("names package.json when key hashing overflows the stack, not a bare RangeError", () => {
      const depth = 200_000;
      writeFileSync(
        join(project, "package.json"),
        `{"name":"acme","deep":${"[".repeat(depth)}${"]".repeat(depth)}}`,
      );
      const release = render();

      const thrown = catching(() => plan(release));

      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(RangeError);
      expect((thrown as Error).message).toContain("package.json");
    });
  });
});
