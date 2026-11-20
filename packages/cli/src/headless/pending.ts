// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The pending document an `--adopt --json` survey writes to
 * `.groundwork/headless/pending.json` (`.claude/rules/headless-mode.md`,
 * "Pending location"): an answers v1 document under the `partial` profile,
 * bound to the survey by `basis.inventorySha256`. Pure: the caller hashes and
 * writes. Safe defaults are prefilled; every decision nobody made -- `kind`,
 * `runtime` and each divergent baseline file's resolution -- is `null` and
 * listed in `pending`.
 */
import type { FileConflict } from "../conflicts.js";
import type { Inventory } from "../inventory.js";
import {
  BASELINE_AGENTS,
  PROJECT_KINDS,
  RUNTIME_TARGETS,
  type AnswersV1,
  type PendingEntry,
} from "./contract.js";

/** What binds the document to the survey it was built from. */
interface AdoptPendingBasis {
  /** The lowercase hex SHA-256 of `inventory.json`'s bytes as written. */
  readonly inventorySha256: string;
}

const KIND_REASON =
  "the project kind has no default; the survey cannot tell which kind this project is";
const RUNTIME_REASON =
  "the runtime target has no default; the survey cannot tell where this project runs";
const CONFLICT_REASON =
  "the project's file differs from the baseline's; only the owner can choose which to keep";

/** The keys a key-level comparison found different, or `undefined` for a whole-file conflict (an empty list counts as whole-file). */
function differingKeys(conflict: FileConflict): readonly string[] | undefined {
  const keys = conflict.keyDiffs;
  return keys !== undefined && keys.length > 0 ? keys : undefined;
}

/** The pending entry for the divergent conflict at `index` of `adopt.conflicts`. */
function conflictEntry(conflict: FileConflict, index: number): PendingEntry {
  const keys = differingKeys(conflict);
  return {
    pointer: `/adopt/conflicts/${String(index)}/resolution`,
    reason: CONFLICT_REASON,
    choices:
      keys === undefined
        ? ["keep", "take", "delegate"]
        : ["keep", "take", "delegate", "merge-keys"],
    evidence:
      keys === undefined
        ? "whole file differs"
        : `differs in keys: ${keys.join(", ")}`,
  };
}

/**
 * Builds the adopt survey's pending document from its inventory. Absent
 * baseline files become `add` additions and identical ones are omitted, both
 * in inventory order; each divergent file becomes a conflict with a `null`
 * resolution and a pending entry offering `keep`, `take` and `delegate`, plus
 * `merge-keys` when the comparison was key-level. `interview.kind` and
 * `runtime` are `null` and pending; `testsMandatory` (`true`), `ciDepth`
 * (`"standard"`) and `keepAgents` (every baseline agent) are prefilled, packs,
 * plugins and guidance are empty or off. Deterministic and timestamp-free;
 * the result always passes `validateAnswers(doc, "partial")` and never
 * `"complete"`.
 *
 * @example
 * ```ts
 * import { createHash } from "node:crypto";
 * import { readFileSync } from "node:fs";
 * import { buildAdoptPending } from "./headless/pending.js";
 * import type { Inventory } from "./inventory.js";
 *
 * const bytes = readFileSync(".groundwork/inventory.json");
 * const inventory = JSON.parse(bytes.toString("utf8")) as Inventory;
 * const doc = buildAdoptPending(inventory, {
 *   inventorySha256: createHash("sha256").update(bytes).digest("hex"),
 * });
 * console.log(doc.pending.map((entry) => entry.pointer));
 * ```
 */
export function buildAdoptPending(
  inventory: Inventory,
  basis: AdoptPendingBasis,
): AnswersV1 {
  const additions = inventory.conflicts
    .filter((c) => c.status === "absent")
    .map((c) => ({ path: c.relPath, action: "add" as const }));
  const divergent = inventory.conflicts.filter((c) => c.status === "divergent");
  return {
    schema: "groundwork.answers",
    schemaVersion: 1,
    mode: "adopt",
    basis: { inventorySha256: basis.inventorySha256 },
    fresh: null,
    interview: {
      kind: null,
      runtime: null,
      testsMandatory: true,
      ciDepth: "standard",
      keepAgents: [...BASELINE_AGENTS],
    },
    adopt: {
      additions,
      conflicts: divergent.map((c) => ({ path: c.relPath, resolution: null })),
      missedNotes: "",
    },
    upgrade: null,
    packs: { install: [], decline: [] },
    plugins: { enabled: [], declined: [] },
    guidance: { enabled: false, domains: [] },
    pending: [
      {
        pointer: "/interview/kind",
        reason: KIND_REASON,
        choices: [...PROJECT_KINDS],
        evidence: null,
      },
      {
        pointer: "/interview/runtime",
        reason: RUNTIME_REASON,
        choices: [...RUNTIME_TARGETS],
        evidence: null,
      },
      ...divergent.map(conflictEntry),
    ],
  };
}
