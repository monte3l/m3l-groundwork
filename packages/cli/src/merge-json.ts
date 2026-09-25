// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Pure, deterministic merges over parsed JSON -- the entire mechanism that
 * lets a pack extend `.claude/settings.json` (its `hooks` block and a few
 * top-level keys), `package.json`'s `scripts`, and
 * `bin/lib/verify-steps.packs.json` without `packages/cli` ever parsing
 * YAML or JavaScript. Every merge is append-only (it never rebuilds an
 * object wholesale, which would risk reordering keys Prettier would
 * otherwise preserve) and idempotent (merging the same fragment twice
 * produces the same result as merging it once).
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structural equality over parsed JSON: leaves by `Object.is`, arrays by
 * length and per-index recursion, plain objects by the same key set (in any
 * order) and per-key recursion. Unlike comparing `JSON.stringify` output, two
 * objects whose keys were merely inserted in a different order are equal --
 * which is what separates an idempotent re-merge from a real collision.
 *
 * @example
 * ```ts
 * deepEqual({ a: 1, b: [2] }, { b: [2], a: 1 }); // true
 * deepEqual([1, 2], [2, 1]); // false
 * ```
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => deepEqual(item, b[index]))
    );
  }
  if (isRecord(a) && isRecord(b)) {
    const aKeys = Object.keys(a);
    return (
      aKeys.length === Object.keys(b).length &&
      aKeys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
    );
  }
  return Object.is(a, b);
}

interface SettingsHookCommand {
  type: string;
  command: string;
  if?: string;
  timeout?: number;
}

interface SettingsHookEntry {
  matcher?: string;
  hooks: SettingsHookCommand[];
}

export type SettingsHooksFragment = Record<string, SettingsHookEntry[]>;

/**
 * Merges a pack's `.claude/settings.json` hook fragment into an existing
 * settings object. Per event, an entry is matched by `matcher` (both absent
 * counts as a match -- e.g. `PreCompact`, which has none); within a matched
 * entry, only `hooks` commands not already present (compared by exact
 * `command` string) are appended. A command that matches on `command` but
 * differs in its other fields (`if`, `timeout`) is a hard collision, never
 * a silent overwrite.
 */
export function mergeSettingsHooks(
  existing: unknown,
  fragment: SettingsHooksFragment,
): Record<string, unknown> {
  const settings: Record<string, unknown> = isRecord(existing)
    ? { ...existing }
    : {};
  const existingHooks = settings["hooks"];
  const hooks: Record<string, SettingsHookEntry[]> = isRecord(existingHooks)
    ? { ...(existingHooks as Record<string, SettingsHookEntry[]>) }
    : {};

  for (const [event, entries] of Object.entries(fragment)) {
    const existingEntries = Array.isArray(hooks[event])
      ? [...hooks[event]]
      : [];

    for (const entry of entries) {
      const matchIndex = existingEntries.findIndex(
        (candidate) =>
          (candidate.matcher ?? undefined) === (entry.matcher ?? undefined),
      );

      if (matchIndex === -1) {
        existingEntries.push(entry);
        continue;
      }

      const matched = existingEntries[matchIndex];
      if (matched === undefined) {
        continue;
      }
      const mergedHooks = [...matched.hooks];

      for (const hookCmd of entry.hooks) {
        const duplicate = mergedHooks.find(
          (candidate) => candidate.command === hookCmd.command,
        );
        if (duplicate) {
          if (!deepEqual(duplicate, hookCmd)) {
            throw new Error(
              `settings.json merge collision: "${event}" (matcher ${JSON.stringify(entry.matcher)}) already has a hook for "${hookCmd.command}" with different config`,
            );
          }
          continue; // Identical entry already present -- idempotent no-op.
        }
        mergedHooks.push(hookCmd);
      }

      existingEntries[matchIndex] = { ...matched, hooks: mergedHooks };
    }

    hooks[event] = existingEntries;
  }

  return { ...settings, hooks };
}

export type SettingsTopLevelFragment = Record<string, unknown>;

/**
 * Merges a pack's top-level `.claude/settings.json` keys (`statusLine`,
 * `subagentStatusLine` -- settings that are not hook registrations) into an
 * existing settings object. Disjoint from `mergeSettingsHooks`, which owns the
 * `hooks` block: a fragment key of `hooks` is rejected outright rather than
 * silently clobbering it. A key not yet present is appended; one already
 * present with an identical value is a no-op; one present with a different
 * value is a hard collision, never a silent overwrite -- an adopted project's
 * own `statusLine` is the user's to replace deliberately.
 */
export function mergeSettingsTopLevel(
  existing: unknown,
  fragment: SettingsTopLevelFragment,
): Record<string, unknown> {
  const settings: Record<string, unknown> = isRecord(existing)
    ? { ...existing }
    : {};

  for (const [key, value] of Object.entries(fragment)) {
    if (key === "hooks") {
      throw new Error(
        'settings.json merge: "hooks" is owned by mergeSettingsHooks and cannot be set as a top-level key',
      );
    }
    if (!Object.hasOwn(settings, key)) {
      settings[key] = value;
      continue;
    }
    if (!deepEqual(settings[key], value)) {
      throw new Error(
        `settings.json merge collision: "${key}" is already set with a different value`,
      );
    }
    // Identical value already present -- idempotent no-op.
  }

  return settings;
}

interface ScriptCollision {
  name: string;
  existing: string;
  incoming: string;
}

export interface MergePackageScriptsResult {
  scripts: Record<string, string>;
  collisions: ScriptCollision[];
}

/**
 * Merges a pack's `package.json` script additions into the existing
 * `scripts` block. Never overwrites a differing existing script -- the
 * collision is returned for the caller to report, consistent with adopt
 * mode's "report, then the user decides per conflict" policy.
 */
export function mergePackageScripts(
  existing: Record<string, string> | undefined,
  additions: Record<string, string>,
): MergePackageScriptsResult {
  const scripts = { ...(existing ?? {}) };
  const collisions: ScriptCollision[] = [];

  for (const [name, cmd] of Object.entries(additions)) {
    // Object.hasOwn, not `scripts[name] !== undefined`: bracket access walks
    // the prototype chain, so an addition named `toString`/`constructor`
    // would otherwise "collide" with an inherited Object.prototype member.
    const currentValue = Object.hasOwn(scripts, name)
      ? scripts[name]
      : undefined;
    if (currentValue !== undefined) {
      if (currentValue !== cmd) {
        collisions.push({ name, existing: currentValue, incoming: cmd });
      }
      continue; // Either identical (no-op) or a collision already recorded.
    }
    scripts[name] = cmd;
  }

  return { scripts, collisions };
}

export interface VerifyStepAddition {
  id: string;
  group: string;
  name: string;
  cmd: string[];
}

/**
 * Merges a pack's verify-step additions into an existing step array
 * (`bin/lib/verify-steps.packs.json`'s parsed contents). Append-by-`id`,
 * idempotent; a same-`id`-different-content collision is a hard error.
 */
export function mergeVerifySteps(
  existing: unknown,
  additions: VerifyStepAddition[],
): VerifyStepAddition[] {
  const current: VerifyStepAddition[] = Array.isArray(existing)
    ? [...(existing as VerifyStepAddition[])]
    : [];

  for (const step of additions) {
    const existingIndex = current.findIndex(
      (candidate) => candidate.id === step.id,
    );
    if (existingIndex === -1) {
      current.push(step);
      continue;
    }
    const existingStep = current[existingIndex];
    if (!deepEqual(existingStep, step)) {
      throw new Error(
        `verify-steps.packs.json merge collision: step "${step.id}" is already registered with different config`,
      );
    }
    // Identical entry already present -- idempotent no-op.
  }

  return current;
}
