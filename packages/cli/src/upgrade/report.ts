// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Renders `.groundwork/upgrade/upgrade-report.md` from an {@link UpgradePlan}:
 * the human view of what `--upgrade` found. Pure: no file system, no clock,
 * so the same plan always renders the same bytes, whatever the order of its
 * entries.
 */
import type { UpgradeClass } from "./classify.js";
import type { UpgradePlan } from "./plan.js";

type PlanFile = UpgradePlan["files"][number];

/** The report's section a file of each class is listed under. */
type Section = "decision" | "safe" | "removed" | "unlisted";

/** Every class, in the order the summary table lists them. */
const SUMMARY_ORDER: readonly UpgradeClass[] = [
  "conflict-3way",
  "conflict-2way",
  "safe-update",
  "add",
  "remove",
  "orphan-edited",
  "user-deleted",
  "local-only",
  "gone",
  "current",
];

/** Where the staged copies live, relative to the project root. */
const STAGED_DIR = ".groundwork/upgrade/staged/";

/**
 * The section each class is listed under; a table keyed by every class, so a
 * new class is a compile error until it is placed.
 */
const SECTION_OF: Readonly<Record<UpgradeClass, Section>> = {
  "conflict-3way": "decision",
  "conflict-2way": "decision",
  "safe-update": "safe",
  add: "safe",
  remove: "removed",
  "orphan-edited": "removed",
  "user-deleted": "unlisted",
  "local-only": "unlisted",
  gone: "unlisted",
  current: "unlisted",
};

/** Code-unit order, the order the plan itself sorts by. */
function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * How many of `files` fall in each class, for every class that occurs, in
 * the report's fixed order: conflicts first, `current` last. The summary
 * table and the CLI's one-line summary both read it.
 *
 * @example
 * ```ts
 * import { countClasses } from "./upgrade/report.js";
 *
 * countClasses([{ path: "a", class: "current" }, { path: "b", class: "add" }]);
 * // [["add", 1], ["current", 1]]
 * ```
 */
export function countClasses(
  files: readonly PlanFile[],
): [UpgradeClass, number][] {
  const counts = new Map<UpgradeClass, number>();
  for (const entry of files) {
    counts.set(entry.class, (counts.get(entry.class) ?? 0) + 1);
  }
  return SUMMARY_ORDER.flatMap((cls): [UpgradeClass, number][] => {
    const count = counts.get(cls);
    return count === undefined ? [] : [[cls, count]];
  });
}

function summaryLines(files: readonly PlanFile[]): string[] {
  const rows = countClasses(files).map(
    ([cls, count]) => `| ${cls} | ${String(count)} |`,
  );
  return ["## Summary", "", "| class | files |", "| --- | --- |", ...rows];
}

/** A `## title` section listing `entries` as sorted bullets; none when empty. */
function pathSection(
  title: string,
  intro: string,
  entries: readonly PlanFile[],
): string[] {
  if (entries.length === 0) return [];
  const bullets = [...entries]
    .sort((a, b) => byCodeUnit(a.path, b.path))
    .map((entry) => `- \`${entry.path}\` (${entry.class})`);
  return ["", `## ${title}`, "", intro, "", ...bullets];
}

function keyLevelLines(jsonKeys: UpgradePlan["jsonKeys"]): string[] {
  const blocks = Object.keys(jsonKeys)
    .sort(byCodeUnit)
    .flatMap((path) => {
      const entries = Object.hasOwn(jsonKeys, path) ? jsonKeys[path] : [];
      const changed = (entries ?? [])
        .filter((entry) => entry.class !== "current")
        .sort((a, b) => byCodeUnit(a.pointer, b.pointer));
      if (changed.length === 0) return [];
      return [
        `- \`${path}\``,
        ...changed.map((entry) => `  - \`${entry.pointer}\`: ${entry.class}`),
      ];
    });
  if (blocks.length === 0) return [];
  return [
    "",
    "## Key-level changes",
    "",
    "The JSON files below are compared key by key; each key that is not current is listed with its class. A file's own class above decides what happens to it.",
    "",
    ...blocks,
  ];
}

function nextStepLines(staged: boolean, removed: boolean): string[] {
  const lines = [
    "",
    "## Next step",
    "",
    "The `/upgrade` skill that applies a plan is not available yet, so nothing in the project has been changed: this run wrote only under `.groundwork/upgrade/`.",
  ];
  if (!staged && !removed) {
    lines.push(
      "",
      "There is nothing to apply: every baseline file is current, or differs only by a change you made or a file you deleted, which an upgrade keeps.",
    );
    return lines;
  }
  if (staged) {
    lines.push(
      "",
      `The new release's copy of every file under Needs a decision and Safe to apply is staged in \`${STAGED_DIR}\` as \`<path>.staged\`. Apply them by hand: copy a Safe to apply file over the project's, and merge a Needs a decision file with your own changes.`,
    );
  }
  if (removed) {
    lines.push(
      "",
      "The files under Removed upstream are no longer in the baseline. Delete them by hand if you no longer need them.",
    );
  }
  return lines;
}

/**
 * Renders the markdown report for `plan`: a title and the version range, a
 * summary table counting each class that occurs (in a fixed order), then
 * Needs a decision (the conflicts), Safe to apply (safe updates and
 * additions), Removed upstream (removals and edited orphans) and Key-level
 * changes (every JSON key whose class is not `current`), each omitted when
 * empty, and always a Next step that says the `/upgrade` skill is not
 * available yet and nothing in the project has been changed. Paths and
 * pointers are sorted, so the output does not depend on the plan's entry
 * order.
 *
 * @param plan - The plan `computePlan` (`upgrade/plan.ts`) returned.
 * @returns The report, ending in a newline.
 *
 * @example
 * ```ts
 * import { renderUpgradeReport } from "./upgrade/report.js";
 *
 * const text = renderUpgradeReport(plan);
 * text.split("\n")[0]; // "# Upgrade plan"
 * ```
 */
export function renderUpgradeReport(plan: UpgradePlan): string {
  const bySection = (section: Section): PlanFile[] =>
    plan.files.filter((entry) => SECTION_OF[entry.class] === section);
  const decision = bySection("decision");
  const safe = bySection("safe");
  const removed = bySection("removed");
  const lines = [
    "# Upgrade plan",
    "",
    `From ${plan.fromCliVersion} to ${plan.toCliVersion}.`,
    "",
    ...summaryLines(plan.files),
    ...pathSection(
      "Needs a decision",
      "You changed these files and the new release changed them too, or the file differs from the new release with no recorded base to compare against.",
      decision,
    ),
    ...pathSection(
      "Safe to apply",
      "You have not changed these files, or they are new in this release.",
      safe,
    ),
    ...pathSection(
      "Removed upstream",
      "The new release no longer ships these files. A `remove` file is unchanged since it was written; an `orphan-edited` one holds your changes.",
      removed,
    ),
    ...keyLevelLines(plan.jsonKeys),
    ...nextStepLines(decision.length + safe.length > 0, removed.length > 0),
  ];
  return `${lines.join("\n")}\n`;
}
