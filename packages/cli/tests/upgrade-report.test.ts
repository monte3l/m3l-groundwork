// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { nothingToApply, renderUpgradeReport } from "../src/upgrade/report.js";
import type { UpgradeClass } from "../src/upgrade/classify.js";
import type { UpgradePlan } from "../src/upgrade/plan.js";

type Entry = UpgradePlan["files"][number];
type Key = UpgradePlan["jsonKeys"][string][number];

const file = (path: string, cls: UpgradeClass): Entry => ({
  path,
  class: cls,
});

function planOf(
  files: readonly Entry[],
  jsonKeys: Record<string, readonly Key[]> = {},
): UpgradePlan {
  return {
    schemaVersion: 1,
    fromCliVersion: "1.2.0",
    toCliVersion: "1.3.0",
    tokens: { PROJECT_NAME: "acme", YEAR: "2026" },
    packs: [],
    files,
    jsonKeys,
  };
}

const FULL = planOf(
  [
    file("b.md", "conflict-3way"),
    file("a.md", "conflict-3way"),
    file("c.md", "conflict-2way"),
    file("d.txt", "safe-update"),
    file("b.txt", "safe-update"),
    file("e.txt", "add"),
    file("old.txt", "remove"),
    file("edited.txt", "orphan-edited"),
    file("deleted.txt", "user-deleted"),
    file("mine.txt", "local-only"),
    file("gone.txt", "gone"),
    file("same1.txt", "current"),
    file("same2.txt", "current"),
  ],
  {
    "package.json": [
      { pointer: "/name", class: "current" },
      { pointer: "/scripts/test", class: "add" },
      { pointer: "/scripts/verify", class: "safe-update" },
    ],
  },
);

/** The body of the `## <title>` section, or undefined when absent. */
function section(report: string, title: string): string | undefined {
  const parts = report.split(/^## /m).slice(1);
  const hit = parts.find((part) => part.startsWith(`${title}\n`));
  return hit?.slice(title.length + 1);
}

function headings(report: string): string[] {
  return [...report.matchAll(/^## (.+)$/gm)].map((m) => m[1] ?? "");
}

function bulletsOf(body: string): string[] {
  return body.split("\n").filter((l) => l.startsWith("- "));
}

describe("renderUpgradeReport", () => {
  it("starts with the title and states the version range", () => {
    const lines = renderUpgradeReport(FULL).split("\n");
    expect(lines[0]).toBe("# Upgrade plan");
    expect(lines).toContain("From 1.2.0 to 1.3.0.");
  });

  it("emits every section, in the fixed order", () => {
    expect(headings(renderUpgradeReport(FULL))).toEqual([
      "Summary",
      "Needs a decision",
      "Safe to apply",
      "Removed upstream",
      "Key-level changes",
      "Next step",
    ]);
  });

  it("counts the non-zero classes in the fixed order", () => {
    const summary = section(renderUpgradeReport(FULL), "Summary") ?? "";
    const rows = [...summary.matchAll(/^\|\s*([a-z0-9-]+)\s*\|\s*(\d+)\s*\|/gm)]
      .map((m) => [m[1], Number(m[2])])
      .filter(([cls]) => cls !== "class");
    expect(rows).toEqual([
      ["conflict-3way", 2],
      ["conflict-2way", 1],
      ["safe-update", 2],
      ["add", 1],
      ["remove", 1],
      ["orphan-edited", 1],
      ["user-deleted", 1],
      ["local-only", 1],
      ["gone", 1],
      ["current", 2],
    ]);
  });

  it("omits a zero-count class from the summary table", () => {
    const report = renderUpgradeReport(
      planOf([file("a.txt", "add"), file("b.txt", "current")]),
    );
    const summary = section(report, "Summary") ?? "";
    expect(summary).toMatch(/\|\s*add\s*\|\s*1\s*\|/);
    expect(summary).toMatch(/\|\s*current\s*\|\s*1\s*\|/);
    expect(summary).not.toContain("conflict");
    expect(summary).not.toContain("safe-update");
    expect(summary).not.toContain("gone");
  });

  it("lists decision paths as backticked bullets with their class, sorted", () => {
    const body = section(renderUpgradeReport(FULL), "Needs a decision") ?? "";
    const bullets = bulletsOf(body);
    expect(bullets).toHaveLength(3);
    expect(bullets[0]).toMatch(/^- `a\.md`.*conflict-3way/);
    expect(bullets[1]).toMatch(/^- `b\.md`.*conflict-3way/);
    expect(bullets[2]).toMatch(/^- `c\.md`.*conflict-2way/);
  });

  it("lists safe-update and add paths under Safe to apply, sorted", () => {
    const body = section(renderUpgradeReport(FULL), "Safe to apply") ?? "";
    const bullets = bulletsOf(body);
    expect(bullets).toHaveLength(3);
    expect(bullets[0]).toContain("`b.txt`");
    expect(bullets[1]).toContain("`d.txt`");
    expect(bullets[2]).toContain("`e.txt`");
  });

  it("lists remove and orphan-edited paths under Removed upstream", () => {
    const body = section(renderUpgradeReport(FULL), "Removed upstream") ?? "";
    expect(body).toContain("`old.txt`");
    expect(body).toContain("`edited.txt`");
    expect(body).not.toContain("deleted.txt");
    expect(body).not.toContain("mine.txt");
  });

  it("does not list user-deleted, local-only, gone or current paths in any path section", () => {
    const report = renderUpgradeReport(FULL);
    for (const title of [
      "Needs a decision",
      "Safe to apply",
      "Removed upstream",
    ]) {
      const body = section(report, title) ?? "";
      for (const path of ["deleted.txt", "mine.txt", "gone.txt", "same1.txt"]) {
        expect(body).not.toContain(path);
      }
    }
  });

  it("lists only non-current pointers in Key-level changes", () => {
    const body = section(renderUpgradeReport(FULL), "Key-level changes") ?? "";
    expect(body).toContain("`/scripts/verify`: safe-update");
    expect(body).toContain("`/scripts/test`: add");
    expect(body).not.toContain("`/name`");
    expect(body).toContain("package.json");
  });

  it("omits Key-level changes when every pointer is current", () => {
    const report = renderUpgradeReport(
      planOf([file("package.json", "safe-update")], {
        "package.json": [{ pointer: "/name", class: "current" }],
      }),
    );
    expect(headings(report)).not.toContain("Key-level changes");
  });

  it("omits every empty section, keeping Summary and Next step", () => {
    const report = renderUpgradeReport(planOf([file("a.txt", "add")]));
    expect(headings(report)).toEqual(["Summary", "Safe to apply", "Next step"]);
  });

  it("states plainly in Next step that /upgrade is not available, nothing changed, and where the staged copies are", () => {
    const next = section(renderUpgradeReport(FULL), "Next step") ?? "";
    expect(next).toMatch(/\/upgrade.*not available yet/is);
    expect(next).toMatch(/nothing in the project has been changed/i);
    expect(next).toContain(".groundwork/upgrade/staged/");
    expect(next).not.toMatch(/nothing to apply/i);
  });

  it("tells the reader to run `--upgrade --stamp` after applying the staged files", () => {
    const next = section(renderUpgradeReport(FULL), "Next step") ?? "";
    expect(next).toContain("--upgrade --stamp");
    expect(next).toMatch(/apply/i);
  });

  it("tells the reader to run `--upgrade --stamp` for a remove-only plan with nothing staged", () => {
    const next =
      section(
        renderUpgradeReport(planOf([file("x", "remove")])),
        "Next step",
      ) ?? "";
    expect(next).toContain("--upgrade --stamp");
  });

  it.each([
    ["current only", [file("a", "current")]],
    [
      "current, local-only, user-deleted and gone",
      [
        file("a", "current"),
        file("b", "local-only"),
        file("c", "user-deleted"),
        file("d", "gone"),
      ],
    ],
  ])(
    "keeps the nothing-to-apply paragraph and adds the exact stamp paragraph (%s)",
    (_name, files) => {
      const next =
        section(renderUpgradeReport(planOf(files)), "Next step") ?? "";
      expect(next).toContain(
        "There is nothing to apply: every baseline file is current, or differs only by a change you made or a file you deleted, which an upgrade keeps.\n\nRun `npx @monte3l/groundwork --upgrade --stamp .` to record the new release in `.groundwork/manifest.json`: nothing needs applying first.",
      );
    },
  );

  it.each(["remove", "orphan-edited", "conflict-2way"] as const)(
    "does not claim nothing to apply when a %s entry exists",
    (cls) => {
      const next =
        section(renderUpgradeReport(planOf([file("x", cls)])), "Next step") ??
        "";
      expect(next).not.toMatch(/nothing to apply/i);
    },
  );

  it("says there is nothing to apply for a plan of only current entries", () => {
    const report = renderUpgradeReport(
      planOf([file("a.txt", "current"), file("b.txt", "current")]),
    );
    expect(headings(report)).toEqual(["Summary", "Next step"]);
    expect(section(report, "Next step")).toMatch(/nothing to apply/i);
  });

  it("says there is nothing to apply for current, local-only, user-deleted and gone only", () => {
    const report = renderUpgradeReport(
      planOf([
        file("a", "current"),
        file("b", "local-only"),
        file("c", "user-deleted"),
        file("d", "gone"),
      ]),
    );
    expect(section(report, "Next step")).toMatch(/nothing to apply/i);
    expect(headings(report)).toEqual(["Summary", "Next step"]);
  });

  it("is deterministic and input-order independent for path lists", () => {
    const reversed = planOf([...FULL.files].reverse(), FULL.jsonKeys);
    expect(renderUpgradeReport(FULL)).toBe(renderUpgradeReport(FULL));
    expect(renderUpgradeReport(reversed)).toBe(renderUpgradeReport(FULL));
  });
});

const KEY_INTRO =
  "The JSON files below are compared key by key; each key that is not current is listed with its class. A file's own class above decides what happens to it.";
const NOT_YET =
  "The `/upgrade` skill that applies a plan is not available yet, so nothing in the project has been changed: this run wrote only under `.groundwork/upgrade/`.";
const REMOVED_INTRO =
  "The new release no longer ships these files. A `remove` file is unchanged since it was written; an `orphan-edited` one holds your changes.";
const REMOVED_STEP =
  "The files under Removed upstream are no longer in the baseline. Delete them by hand if you no longer need them.";
const STAGED_STEP =
  "The new release's copy of every file under Needs a decision and Safe to apply is staged in `.groundwork/upgrade/staged/` as `<path>.staged`. Apply them by hand: copy a Safe to apply file over the project's, and merge a Needs a decision file with your own changes.";

const STAMP_STEP =
  "Once you have applied the changes you want, run `npx @monte3l/groundwork --upgrade --stamp .` to record the result in `.groundwork/manifest.json`. A change you did not apply is recorded as yours, so the next upgrade compares that file two-way.";

describe("renderUpgradeReport (exact, hand-written expectations)", () => {
  it("renders the full plan exactly", () => {
    const expected = [
      "# Upgrade plan",
      "",
      "From 1.2.0 to 1.3.0.",
      "",
      "## Summary",
      "",
      "| class | files |",
      "| --- | --- |",
      "| conflict-3way | 2 |",
      "| conflict-2way | 1 |",
      "| safe-update | 2 |",
      "| add | 1 |",
      "| remove | 1 |",
      "| orphan-edited | 1 |",
      "| user-deleted | 1 |",
      "| local-only | 1 |",
      "| gone | 1 |",
      "| current | 2 |",
      "",
      "## Needs a decision",
      "",
      "You changed these files and the new release changed them too, or the file differs from the new release with no recorded base to compare against.",
      "",
      "- `a.md` (conflict-3way)",
      "- `b.md` (conflict-3way)",
      "- `c.md` (conflict-2way)",
      "",
      "## Safe to apply",
      "",
      "You have not changed these files, or they are new in this release.",
      "",
      "- `b.txt` (safe-update)",
      "- `d.txt` (safe-update)",
      "- `e.txt` (add)",
      "",
      "## Removed upstream",
      "",
      REMOVED_INTRO,
      "",
      "- `edited.txt` (orphan-edited)",
      "- `old.txt` (remove)",
      "",
      "## Key-level changes",
      "",
      KEY_INTRO,
      "",
      "- `package.json`",
      "  - `/scripts/test`: add",
      "  - `/scripts/verify`: safe-update",
      "",
      "## Next step",
      "",
      NOT_YET,
      "",
      STAGED_STEP,
      "",
      REMOVED_STEP,
      "",
      STAMP_STEP,
      "",
    ].join("\n");
    expect(renderUpgradeReport(FULL)).toBe(expected);
  });

  it("renders a remove-only plan exactly (nothing staged, something removed)", () => {
    const expected = [
      "# Upgrade plan",
      "",
      "From 1.2.0 to 1.3.0.",
      "",
      "## Summary",
      "",
      "| class | files |",
      "| --- | --- |",
      "| remove | 1 |",
      "",
      "## Removed upstream",
      "",
      REMOVED_INTRO,
      "",
      "- `old.txt` (remove)",
      "",
      "## Next step",
      "",
      NOT_YET,
      "",
      REMOVED_STEP,
      "",
      STAMP_STEP,
      "",
    ].join("\n");
    expect(renderUpgradeReport(planOf([file("old.txt", "remove")]))).toBe(
      expected,
    );
  });

  it("sorts unsorted input paths, files and pointers", () => {
    const plan = planOf(
      [
        file("z.txt", "safe-update"),
        file("m.txt", "add"),
        file("a.txt", "safe-update"),
      ],
      {
        "tsconfig.json": [
          { pointer: "/z", class: "add" },
          { pointer: "/a", class: "safe-update" },
        ],
        "package.json": [
          { pointer: "/scripts/z", class: "add" },
          { pointer: "/scripts/a", class: "safe-update" },
        ],
      },
    );
    const expected = [
      "# Upgrade plan",
      "",
      "From 1.2.0 to 1.3.0.",
      "",
      "## Summary",
      "",
      "| class | files |",
      "| --- | --- |",
      "| safe-update | 2 |",
      "| add | 1 |",
      "",
      "## Safe to apply",
      "",
      "You have not changed these files, or they are new in this release.",
      "",
      "- `a.txt` (safe-update)",
      "- `m.txt` (add)",
      "- `z.txt` (safe-update)",
      "",
      "## Key-level changes",
      "",
      KEY_INTRO,
      "",
      "- `package.json`",
      "  - `/scripts/a`: safe-update",
      "  - `/scripts/z`: add",
      "- `tsconfig.json`",
      "  - `/a`: safe-update",
      "  - `/z`: add",
      "",
      "## Next step",
      "",
      NOT_YET,
      "",
      STAGED_STEP,
      "",
      STAMP_STEP,
      "",
    ].join("\n");
    expect(renderUpgradeReport(plan)).toBe(expected);
  });
});

describe("nothingToApply", () => {
  // Typed exhaustively: a new UpgradeClass is a compile error until it is
  // given an expectation here.
  const EXPECTED: Readonly<Record<UpgradeClass, boolean>> = {
    current: true,
    "local-only": true,
    "user-deleted": true,
    gone: true,
    add: false,
    "safe-update": false,
    "conflict-2way": false,
    "conflict-3way": false,
    remove: false,
    "orphan-edited": false,
  };

  it.each(Object.entries(EXPECTED) as [UpgradeClass, boolean][])(
    "a plan holding only a %s entry gives %s",
    (cls, expected) => {
      expect(nothingToApply([file("x", cls)])).toBe(expected);
    },
  );

  it("is false for a mixed plan of one current and one add entry", () => {
    expect(nothingToApply([file("a", "current"), file("b", "add")])).toBe(
      false,
    );
  });

  it("is true for an empty list", () => {
    expect(nothingToApply([])).toBe(true);
  });
});
