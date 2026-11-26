// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Property-based coverage for tarball.ts: every valid generated archive
 * round-trips, and no archive, however hostile its names, ever yields a key
 * that could escape the template tree.
 */
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { readTemplateTarball, TarballError } from "../src/tarball.js";
import { buildTgz } from "./tarball-fixtures.js";

const segment = fc.stringMatching(/^[a-z0-9_-][a-z0-9._-]{0,7}$/);
const relPath = fc
  .array(segment, { minLength: 1, maxLength: 4 })
  .map((parts) => parts.join("/"));
const content = fc.uint8Array({ maxLength: 1200 });

const validEntries = fc.uniqueArray(fc.tuple(relPath, content), {
  selector: ([path]) => path,
  maxLength: 8,
});

describe("readTemplateTarball properties", () => {
  it("round-trips any valid archive of template files", () => {
    fc.assert(
      fc.property(validEntries, (entries) => {
        // A path that is also another entry's directory cannot coexist on
        // disk, but a tarball may hold both; keys stay independent.
        const gz = buildTgz(
          entries.map(([path, data]) => ({
            name: `package/templates/${path}`,
            data,
          })),
        );
        const files = readTemplateTarball(gz);
        expect(files.size).toBe(entries.length);
        for (const [path, data] of entries) {
          expect([...(files.get(path) ?? [])]).toEqual([...data]);
        }
      }),
    );
  });

  it("never returns a key with a .. segment, a leading / or a backslash", () => {
    const hostile = fc
      .array(fc.constantFrom("a", "b", "..", ".", "", "x\\y", "c.txt"), {
        minLength: 1,
        maxLength: 5,
      })
      .map((parts) => parts.join("/"));
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.boolean(), hostile, content), { maxLength: 5 }),
        (entries) => {
          const gz = buildTgz(
            entries.map(([absolute, path, data]) => ({
              name: `${absolute ? "/" : ""}package/templates/${path}`,
              data,
            })),
          );
          let files: ReadonlyMap<string, Uint8Array>;
          try {
            files = readTemplateTarball(gz);
          } catch (error) {
            expect(error).toBeInstanceOf(TarballError);
            return;
          }
          for (const key of files.keys()) {
            expect(key.split("/")).not.toContain("..");
            expect(key.startsWith("/")).toBe(false);
            expect(key).not.toContain("\\");
          }
        },
      ),
    );
  });
});
