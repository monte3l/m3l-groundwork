// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Renders `.groundwork/upgrade/upgrade-report.md` from an {@link UpgradePlan}:
 * the human view of what `--upgrade` found. Pure: no file system, no clock,
 * so the same plan always renders the same bytes, whatever the order of its
 * entries.
 */
import type { UpgradeClass } from "./classify.js";
import { UPGRADE_RELATIVE_DIR, UPGRADE_STAGED_DIR_NAME } from "./paths.js";
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
const STAGED_DIR = `${UPGRADE_RELATIVE_DIR}/${UPGRADE_STAGED_DIR_NAME}/`;

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

/**
 * Whether `files` holds nothing to apply: no entry is listed under Needs a
 * decision, Safe to apply or Removed upstream, so every baseline file is
 * current or differs only by the user's own change or deletion. The report's
 * Next step and the CLI's `Next:` line both read it; such a plan still needs
 * `--upgrade --stamp` to record the new release in the manifest.
 *
 * @example
 * ```ts
 * import { nothingToApply } from "./upgrade/report.js";
 *
 * nothingToApply([{ path: "a", class: "current" }]); // true
 * nothingToApply([{ path: "b", class: "add" }]); // false
 * ```
 */
export function nothingToApply(files: readonly PlanFile[]): boolean {
  return files.every((entry) => SECTION_OF[entry.class] === "unlisted");
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

function nextStepLines(
  nothing: boolean,
  staged: boolean,
  removed: boolean,
): string[] {
  const wroteOnly = `This run wrote this plan only under \`${UPGRADE_RELATIVE_DIR}/\`; the \`/upgrade\` skill is installed separately, as the console output says.`;
  if (nothing) {
    return [
      "",
      "## Next step",
      "",
      "There is nothing to apply: every baseline file is current, or differs only by a change you made or a file you deleted, which an upgrade keeps.",
      "",
      "Run `npx @monte3l/groundwork --upgrade --stamp .` to record the new release in `.groundwork/manifest.json`: nothing needs applying first.",
      "",
      wroteOnly,
    ];
  }
  const lines = [
    "",
    "## Next step",
    "",
    `Run \`/upgrade\` in Claude Code to apply this plan. ${wroteOnly}`,
  ];
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
  lines.push(
    "",
    "Once you have applied the changes you want, run `npx @monte3l/groundwork --upgrade --stamp .` to record the result in `.groundwork/manifest.json`. A change you did not apply is recorded as yours, so the next upgrade compares that file two-way.",
  );
  return lines;
}

/**
 * Renders the markdown report for `plan`: a title and the version range, a
 * summary table counting each class that occurs (in a fixed order), then
 * Needs a decision (the conflicts), Safe to apply (safe updates and
 * additions), Removed upstream (removals and edited orphans) and Key-level
 * changes (every JSON key whose class is not `current`), each omitted when
 * empty, and always a Next step. When {@link nothingToApply} holds, the Next
 * step says there is nothing to apply and that `--upgrade --stamp` still
 * records the new release in the manifest, and never tells the reader to run
 * `/upgrade`; otherwise it says to run `/upgrade` in Claude Code to apply the
 * plan, what to apply by hand instead, and to run `--upgrade --stamp` once
 * that is done. Both end or begin with the same sentence: the run wrote the
 * plan only under `.groundwork/upgrade/`, and the skill is installed
 * separately (the report is written before the install, so it cannot say
 * where). Paths and
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
    ...nextStepLines(
      nothingToApply(plan.files),
      decision.length + safe.length > 0,
      removed.length > 0,
    ),
  ];
  return `${lines.join("\n")}\n`;
}
