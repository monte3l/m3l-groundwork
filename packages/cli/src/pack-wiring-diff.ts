// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Compares two versions of one pack's `wiring` item by item, and says for
 * each removed or changed item whether the project still holds the old
 * manifest's value -- the only case an update may remove or replace it
 * without overwriting an owner's edit. Read-only: the project's three wiring
 * files are read through `pack-installation.ts`'s guarded project reads.
 */
import { isPrototypeSensitiveKey, isRecord, jsonEqual } from "./merge-json.js";
import { readJsonFile } from "./pack-installation.js";
import type { PackManifest, PackWiring } from "./packs.js";

/** One wiring item that only the new manifest has. */
interface WiringDiffItem {
  /** `settings:<event>:<command>` (`settings:<event>[<matcher>]:<command>` with a matcher), `settingsTopLevel:<key>`, `packageScripts:<name>` or `verifySteps:<id>`. */
  readonly key: string;
}

/** A wiring item only the old manifest has. */
interface WiringRemoval extends WiringDiffItem {
  /** True only when the project's value still equals the old manifest's. */
  readonly removable: boolean;
  /** Why it is not removable; absent when it is. */
  readonly reason?: string;
}

/** A wiring item both manifests have, with different values. */
interface WiringChange extends WiringDiffItem {
  /** True only when the project's value still equals the old manifest's. */
  readonly applies: boolean;
  /** Why it does not apply; absent when it does. */
  readonly reason?: string;
}

/** {@link diffPackWiring}'s result. */
export interface PackWiringDiff {
  readonly added: readonly WiringDiffItem[];
  readonly removed: readonly WiringRemoval[];
  readonly changed: readonly WiringChange[];
}

type ProjectFile = "settings" | "packageJson" | "verifySteps";

const PROJECT_FILES: Readonly<Record<ProjectFile, string>> = {
  settings: ".claude/settings.json",
  packageJson: "package.json",
  verifySteps: "bin/lib/verify-steps.packs.json",
};

type Lookup =
  { readonly found: true; readonly value: unknown } | { readonly found: false };

const NOT_FOUND: Lookup = { found: false };

interface WiringItem {
  readonly key: string;
  readonly value: unknown;
  readonly file: ProjectFile;
  /** Finds this item's current value in the parsed project file. */
  readonly locate: (parsed: unknown) => Lookup;
}

function ownValue(record: unknown, key: string): Lookup {
  if (!isRecord(record) || !Object.hasOwn(record, key)) return NOT_FOUND;
  return { found: true, value: record[key] };
}

function hookValue(matcher: unknown, hook: unknown): unknown {
  return matcher === undefined ? { hook } : { matcher, hook };
}

/** The hook under `event` whose entry has `matcher` (or none) and whose command is `command`. */
function locateHook(
  parsed: unknown,
  event: string,
  matcher: string | undefined,
  command: string,
): Lookup {
  const hooks = ownValue(parsed, "hooks");
  if (!hooks.found) return NOT_FOUND;
  const entries = ownValue(hooks.value, event);
  if (!entries.found || !Array.isArray(entries.value)) return NOT_FOUND;
  for (const entry of entries.value as readonly unknown[]) {
    if (
      !isRecord(entry) ||
      entry["matcher"] !== matcher ||
      !Array.isArray(entry["hooks"])
    ) {
      continue;
    }
    for (const hook of entry["hooks"] as readonly unknown[]) {
      if (isRecord(hook) && hook["command"] === command) {
        return { found: true, value: hookValue(matcher, hook) };
      }
    }
  }
  return NOT_FOUND;
}

function locateStep(parsed: unknown, id: string): Lookup {
  if (!Array.isArray(parsed)) return NOT_FOUND;
  const step = (parsed as readonly unknown[]).find(
    (candidate) => isRecord(candidate) && candidate["id"] === id,
  );
  return step === undefined ? NOT_FOUND : { found: true, value: step };
}

function settingsItems(wiring: PackWiring): WiringItem[] {
  const items: WiringItem[] = [];
  for (const [event, entries] of Object.entries(wiring.settings)) {
    if (isPrototypeSensitiveKey(event)) continue;
    for (const entry of entries) {
      for (const hook of entry.hooks) {
        const { matcher } = entry;
        const scope = matcher === undefined ? event : `${event}[${matcher}]`;
        items.push({
          key: `settings:${scope}:${hook.command}`,
          value: hookValue(matcher, hook),
          file: "settings",
          locate: (parsed) => locateHook(parsed, event, matcher, hook.command),
        });
      }
    }
  }
  return items;
}

function wiringItems(wiring: PackWiring): Map<string, WiringItem> {
  const items = settingsItems(wiring);
  for (const [name, value] of Object.entries(wiring.settingsTopLevel ?? {})) {
    if (isPrototypeSensitiveKey(name)) continue;
    items.push({
      key: `settingsTopLevel:${name}`,
      value,
      file: "settings",
      locate: (parsed) => ownValue(parsed, name),
    });
  }
  for (const [name, value] of Object.entries(wiring.packageScripts)) {
    if (isPrototypeSensitiveKey(name)) continue;
    items.push({
      key: `packageScripts:${name}`,
      value,
      file: "packageJson",
      locate: (parsed) => {
        const scripts = ownValue(parsed, "scripts");
        return scripts.found ? ownValue(scripts.value, name) : NOT_FOUND;
      },
    });
  }
  for (const step of wiring.verifySteps) {
    items.push({
      key: `verifySteps:${step.id}`,
      value: step,
      file: "verifySteps",
      locate: (parsed) => locateStep(parsed, step.id),
    });
  }
  // First occurrence wins, matching the merge's append-if-absent semantics.
  const byKey = new Map<string, WiringItem>();
  for (const item of items) if (!byKey.has(item.key)) byKey.set(item.key, item);
  return byKey;
}

type ParsedFile =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string };

/**
 * Whether the project still holds `item`'s (old) value; `undefined` when it
 * does, otherwise the reason it does not.
 */
function projectMismatch(
  item: WiringItem,
  readFile: (file: ProjectFile) => ParsedFile,
): string | undefined {
  const parsed = readFile(item.file);
  if (!parsed.ok) return parsed.reason;
  const current = item.locate(parsed.value);
  if (!current.found) return `${item.key} is no longer in the project`;
  return jsonEqual(current.value, item.value)
    ? undefined
    : `${item.key} was edited in the project`;
}

/**
 * Diffs `oldManifest`'s wiring against `newManifest`'s by item key:
 * `settings:<event>:<command>`, or `settings:<event>[<matcher>]:<command>`
 * when its entry has a matcher (a hook, located in the project by matcher
 * and command; a changed command is one removal plus one addition), `settingsTopLevel:<key>`, `packageScripts:<name>` and
 * `verifySteps:<id>`. A removed item is `removable`, and a changed one
 * `applies`, only when the project's current value (`.claude/settings.json`,
 * `package.json`'s `scripts`, `bin/lib/verify-steps.packs.json`) deep-equals
 * the OLD manifest's; otherwise it carries a `reason`. Prototype-sensitive
 * names are ignored. Never writes and never throws for a project file: an
 * absent, unreadable or unparseable file is a reason.
 *
 * @example
 * ```ts
 * import { diffPackWiring } from "./pack-wiring-diff.js";
 * import { loadPack } from "./packs.js";
 *
 * const next = loadPack("quality").manifest;
 * const diff = diffPackWiring(previousManifest, next, "/path/to/project");
 * for (const item of diff.removed) {
 *   if (!item.removable) console.log(`${item.key}: ${item.reason ?? ""}`);
 * }
 * ```
 */
export function diffPackWiring(
  oldManifest: PackManifest,
  newManifest: PackManifest,
  projectDir: string,
): PackWiringDiff {
  const oldItems = wiringItems(oldManifest.wiring);
  const newItems = wiringItems(newManifest.wiring);
  const cache = new Map<ProjectFile, ParsedFile>();
  const readFile = (file: ProjectFile): ParsedFile => {
    const cached = cache.get(file);
    if (cached !== undefined) return cached;
    const result: ParsedFile = readJsonFile(projectDir, PROJECT_FILES[file]);
    cache.set(file, result);
    return result;
  };

  const added: WiringDiffItem[] = [];
  const removed: WiringRemoval[] = [];
  const changed: WiringChange[] = [];
  for (const key of newItems.keys()) {
    if (!oldItems.has(key)) added.push({ key });
  }
  for (const [key, oldItem] of oldItems) {
    const newItem = newItems.get(key);
    if (newItem !== undefined && jsonEqual(oldItem.value, newItem.value)) {
      continue;
    }
    const reason = projectMismatch(oldItem, readFile);
    if (newItem === undefined) {
      removed.push(
        reason === undefined
          ? { key, removable: true }
          : { key, removable: false, reason },
      );
    } else {
      changed.push(
        reason === undefined
          ? { key, applies: true }
          : { key, applies: false, reason },
      );
    }
  }
  return { added, removed, changed };
}
