// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

// Pins the two template edits that keep the `.groundwork/` record out of the
// emitted project's own gates: Prettier must not reformat it, and the
// licensing pack's REUSE.toml must cover the `.base` copies.
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const templates = join(here, "..", "..", "..", "..", "templates");

describe("the .groundwork/ record in the emitted templates", () => {
  it("core .prettierignore ignores .groundwork/", () => {
    const lines = readFileSync(
      join(templates, "core", ".prettierignore"),
      "utf8",
    )
      .split("\n")
      .map((line) => line.trim());
    expect(lines).toContain(".groundwork/");
  });

  it("the licensing pack's REUSE.toml annotates .groundwork/base/**", () => {
    const toml = readFileSync(
      join(templates, "packs", "licensing", "files", "REUSE.toml"),
      "utf8",
    );
    expect(toml).toContain('".groundwork/base/**"');
  });

  it.each([".groundwork/add-pack/", ".groundwork/update/"])(
    "core .gitignore lists the staging directory %s",
    (entry) => {
      const lines = readFileSync(join(templates, "core", ".gitignore"), "utf8")
        .split("\n")
        .map((line) => line.trim());
      expect(lines).toContain(entry);
    },
  );

  it("git ignores what --add-pack and --update stage but not the lock or base", () => {
    const repo = mkdtempSync(join(tmpdir(), "groundwork-ignores-"));
    try {
      const env = {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      };
      spawnSync("git", ["init", "-q"], { cwd: repo, env });
      writeFileSync(
        join(repo, ".gitignore"),
        readFileSync(join(templates, "core", ".gitignore")),
      );
      mkdirSync(join(repo, ".groundwork"));
      const ignored = (path: string): boolean =>
        spawnSync("git", ["check-ignore", "-q", path], { cwd: repo, env })
          .status === 0;
      expect(ignored(".groundwork/update/plan.json")).toBe(true);
      expect(ignored(".groundwork/update/files/a.ts.staged")).toBe(true);
      expect(ignored(".groundwork/add-pack/quality/plan.json")).toBe(true);
      expect(ignored(".groundwork/groundwork.lock.json")).toBe(false);
      expect(ignored(".groundwork/base/a.ts.base")).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
