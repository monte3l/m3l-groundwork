// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The three-way JSON merge of the update flow: `base` is the template as it
 * was at bootstrap, `ours` the project's current file, `theirs` the template
 * the running CLI ships. Changes only one side made are taken; a key both
 * sides changed differently is a conflict, reported as a JSON pointer, and
 * keeps ours. Arrays merge as whole values; an absent key is a deletion.
 */
import { parseJsonc } from "./jsonc.js";
import { isPrototypeSensitiveKey, isRecord, jsonEqual } from "./merge-json.js";

/** Marks a key absent on one side, so a deletion merges like any other value. */
const ABSENT: unique symbol = Symbol("absent");

/**
 * Escapes one object key as a JSON pointer reference token (RFC 6901), the
 * form {@link mergeJson3}'s conflict pointers use.
 *
 * @example
 * ```ts
 * pointerToken("a/b~c"); // "a~1b~0c"
 * ```
 */
export function pointerToken(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** Whether `value` holds a prototype-sensitive key at any depth. */
function hasPrototypeKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasPrototypeKey);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, child]) => isPrototypeSensitiveKey(key) || hasPrototypeKey(child),
  );
}

/** Throws on a prototype-sensitive key anywhere inside `value`. */
function assertNoPrototypeKeys(
  value: unknown,
  side: string,
  path: string,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertNoPrototypeKeys(item, side, `${path}/${String(index)}`);
    });
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (isPrototypeSensitiveKey(key)) {
      throw new Error(
        `three-way merge: refusing prototype-sensitive key "${key}" in ${side} at "${path}"`,
      );
    }
    assertNoPrototypeKeys(child, side, `${path}/${pointerToken(key)}`);
  }
}

function slotEqual(a: unknown, b: unknown): boolean {
  if (a === ABSENT || b === ABSENT) return a === b;
  return jsonEqual(a, b);
}

/**
 * Key order of a merged object: ours' order, then each theirs-only key
 * inserted right after its nearest predecessor in theirs (or first).
 */
function mergedKeyOrder(
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
  present: ReadonlySet<string>,
): string[] {
  const order = Object.keys(ours).filter((key) => present.has(key));
  const theirsKeys = Object.keys(theirs);
  theirsKeys.forEach((key, index) => {
    if (!present.has(key) || order.includes(key)) return;
    let at = 0;
    for (let prev = index - 1; prev >= 0; prev--) {
      const found = order.indexOf(theirsKeys[prev] ?? "");
      if (found !== -1) {
        at = found + 1;
        break;
      }
    }
    order.splice(at, 0, key);
  });
  return order;
}

function mergeSlot(
  base: unknown,
  ours: unknown,
  theirs: unknown,
  path: string,
  conflicts: string[],
): unknown {
  if (slotEqual(ours, theirs)) return ours;
  if (slotEqual(ours, base)) return theirs;
  if (slotEqual(theirs, base)) return ours;
  if (isRecord(base) && isRecord(ours) && isRecord(theirs)) {
    const merged = new Map<string, unknown>();
    const keys = new Set([
      ...Object.keys(base),
      ...Object.keys(ours),
      ...Object.keys(theirs),
    ]);
    for (const key of keys) {
      const value = mergeSlot(
        Object.hasOwn(base, key) ? base[key] : ABSENT,
        Object.hasOwn(ours, key) ? ours[key] : ABSENT,
        Object.hasOwn(theirs, key) ? theirs[key] : ABSENT,
        `${path}/${pointerToken(key)}`,
        conflicts,
      );
      if (value !== ABSENT) merged.set(key, value);
    }
    const result: Record<string, unknown> = {};
    for (const key of mergedKeyOrder(ours, theirs, new Set(merged.keys()))) {
      result[key] = merged.get(key);
    }
    return result;
  }
  conflicts.push(path);
  return ours;
}

/**
 * Three-way merges parsed JSON. Per key: ours and theirs agree → ours; only
 * theirs changed it → theirs; only ours changed it → ours; all three are plain
 * objects → recurse; otherwise a conflict, reported as a JSON pointer, keeping
 * ours. A key absent on a side is a deletion, and arrays are whole values. A
 * merged object keeps ours' key order, with theirs-only keys inserted after
 * their predecessor in theirs.
 *
 * @throws `Error` when any input holds a prototype-sensitive key
 *   (`__proto__`, `constructor`, `prototype`) at any depth -- checked on all
 *   three inputs before merging.
 *
 * @example
 * ```ts
 * const { value, conflicts } = mergeJson3({ a: 1, b: 1 }, { a: 2, b: 1 }, { a: 1, b: 3 });
 * // value: { a: 2, b: 3 }, conflicts: []
 * ```
 */
export function mergeJson3(
  base: unknown,
  ours: unknown,
  theirs: unknown,
): { value: unknown; conflicts: string[] } {
  assertNoPrototypeKeys(base, "base", "");
  assertNoPrototypeKeys(ours, "ours", "");
  assertNoPrototypeKeys(theirs, "theirs", "");
  const conflicts: string[] = [];
  const value = mergeSlot(base, ours, theirs, "", conflicts);
  return { value, conflicts };
}

/** The indent `text` uses: a tab, or the first indented line's space count (default 2). */
function detectIndent(text: string): string | number {
  const match = /\n([ \t]+)\S/.exec(text);
  const indent = match?.[1];
  if (indent === undefined) return 2;
  return indent.startsWith("\t") ? "\t" : indent.length;
}

/**
 * Parses strict JSON, or says why the text cannot be merged. The reason is
 * a fixed message: it never quotes the text or the parser's error, which
 * can echo the file's content (a secret, a token).
 */
function parseStrict(
  text: string,
  side: string,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  const loose = parseJsonc(text);
  if (!loose.ok) {
    return { ok: false, reason: `${side} is not valid JSON` };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    // parseJsonc accepted it, so only comments or trailing commas remain --
    // re-serializing would drop them, so the file is left to the owner.
    return {
      ok: false,
      reason: `${side} has comments or trailing commas, which a merge would drop`,
    };
  }
}

/**
 * Three-way merges JSON file text with {@link mergeJson3}. The result is
 * theirs' exact text when the merge equals theirs, ours' exact text when it
 * equals ours, and otherwise a re-serialization in ours' indent (2, 4 or tab)
 * and trailing-newline style. Text with comments or trailing commas, text that
 * does not parse, or a prototype-sensitive key is `{ unmergeable }` with a
 * fixed reason that never quotes the input. A re-serialized result uses LF
 * line endings and carries no BOM, so a CRLF file is normalised to LF.
 *
 * @example
 * ```ts
 * const result = mergeJsonText(baseText, oursText, theirsText);
 * if ("unmergeable" in result) console.log(result.unmergeable);
 * else writeFileSync(path, result.text);
 * ```
 */
export function mergeJsonText(
  baseText: string,
  oursText: string,
  theirsText: string,
): { text: string; conflicts: string[] } | { unmergeable: string } {
  const base = parseStrict(baseText, "base");
  if (!base.ok) return { unmergeable: base.reason };
  const ours = parseStrict(oursText, "ours");
  if (!ours.ok) return { unmergeable: ours.reason };
  const theirs = parseStrict(theirsText, "theirs");
  if (!theirs.ok) return { unmergeable: theirs.reason };

  // Checked up front rather than by catching mergeJson3's throw, so no other
  // error is ever mistaken for this one, and the reason quotes no key.
  if ([base, ours, theirs].some((side) => hasPrototypeKey(side.value))) {
    return {
      unmergeable:
        "a side holds a prototype-sensitive key (__proto__, constructor or prototype)",
    };
  }
  const { value, conflicts } = mergeJson3(base.value, ours.value, theirs.value);
  if (jsonEqual(value, theirs.value)) return { text: theirsText, conflicts };
  if (jsonEqual(value, ours.value)) return { text: oursText, conflicts };
  const newline = oursText.endsWith("\n") ? "\n" : "";
  return {
    text: `${JSON.stringify(value, null, detectIndent(oursText))}${newline}`,
    conflicts,
  };
}
