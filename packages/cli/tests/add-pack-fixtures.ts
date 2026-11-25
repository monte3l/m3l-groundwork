// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Shared fixtures of the `add-pack-stage-*.test.ts` failure-path suites: a
 * real bootstrapped project (`templates/core` plus a real pack) and a
 * byte-level tree snapshot.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { emitTemplate } from "../src/emit.js";
import { templatesCoreDir } from "../src/main.js";
import { installPack, loadPack } from "../src/packs.js";

/** Emits the real baseline, plus the named real packs, into `dir`. */
export function bootstrapInto(dir: string, packs: string[] = []): void {
  const tokens = { PROJECT_NAME: "acme", YEAR: "2026" };
  emitTemplate(templatesCoreDir(), dir, tokens);
  for (const name of packs) {
    installPack(loadPack(name), dir, tokens);
  }
}

/** Every entry under `dir` by relative path: `d`, `l <target>` or `f <sha256>`. */
export function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const rel = relative(dir, full).split("\\").join("/");
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        out[rel] = `l ${readlinkSync(full)}`;
      } else if (stat.isDirectory()) {
        out[rel] = "d";
        walk(full);
      } else {
        out[rel] =
          `f ${createHash("sha256").update(readFileSync(full)).digest("hex")}`;
      }
    }
  };
  walk(dir);
  return out;
}

/** The entries of `snap` at or under `prefix`. */
export function subtreeOf(
  snap: Record<string, string>,
  prefix: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(snap).filter(
      ([key]) => key === prefix || key.startsWith(`${prefix}/`),
    ),
  );
}

/** Every message in `error`'s cause chain, outermost first. */
export function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (current !== undefined && chain.length < 10) {
    chain.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
}
