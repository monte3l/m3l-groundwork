// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const binDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "bin",
);

interface Plan {
  target: string | null;
  deprecate: { version: string; message: string }[];
  alreadyDeprecated: string[];
  refused?: string;
}

interface Packument {
  name?: string;
  "dist-tags": { latest?: string };
  versions: Record<string, { deprecated?: string }>;
}

interface PlanLib {
  compareSemver(a: string, b: string): -1 | 0 | 1;
  planDeprecations(packument: Packument): Plan;
  buildDeprecateRange(name: string, versions: string[]): string;
}

const lib = (await import(
  pathToFileURL(join(binDir, "lib", "deprecation-plan.mjs")).href
)) as PlanLib;

function packument(
  latest: string | undefined,
  versions: Record<string, string | undefined>,
): Packument {
  const out: Packument = {
    "dist-tags": latest === undefined ? {} : { latest },
    versions: {},
  };
  for (const [v, deprecated] of Object.entries(versions)) {
    out.versions[v] = deprecated === undefined ? {} : { deprecated };
  }
  return out;
}

const realWorld = (): Packument =>
  packument("1.0.4", {
    "0.0.0":
      "Empty placeholder. Use @monte3l/groundwork@latest (1.0.0 or later).",
    "0.1.0-next.0": "Superseded by 1.0.0. Use @monte3l/groundwork@latest.",
    "0.1.0-next.1": "Superseded by 1.0.0. Use @monte3l/groundwork@latest.",
    "1.0.0-rc.2": "Superseded by 1.0.0. Use @monte3l/groundwork@latest.",
    "1.0.0-rc.3": "Superseded by 1.0.0. Use @monte3l/groundwork@latest.",
    "1.0.0-rc.4": "Superseded by 1.0.0. Use @monte3l/groundwork@latest.",
    "1.0.0-rc.5": "Superseded by 1.0.0. Use @monte3l/groundwork@latest.",
    "1.0.0-rc.6": "Superseded by 1.0.0. Use @monte3l/groundwork@latest.",
    "1.0.0-rc.7": "Superseded by 1.0.0. Use @monte3l/groundwork@latest.",
    "1.0.0-rc.8": "Superseded by 1.0.0. Use @monte3l/groundwork@latest.",
    "1.0.0": "Superseded by 1.0.1. Use @monte3l/groundwork@latest.",
    "1.0.1": "Superseded by 1.0.3. Use @monte3l/groundwork@latest.",
    "1.0.2": "Superseded by 1.0.3. Use @monte3l/groundwork@latest.",
    "1.0.3": undefined,
    "1.0.4": undefined,
  });

const realWorldFullyDeprecated = (): Packument => {
  const p = realWorld();
  p.versions["1.0.3"] = {
    deprecated: "Superseded by 1.0.4. Use @monte3l/groundwork@latest.",
  };
  return p;
};

describe("compareSemver", () => {
  it.each([
    ["1.0.0-rc.8", "1.0.0", -1],
    ["1.0.0", "1.0.0-rc.8", 1],
    ["1.0.0-rc.2", "1.0.0-rc.10", -1],
    ["0.1.0-next.1", "1.0.0-rc.2", -1],
    ["1.0.0-alpha", "1.0.0-alpha.1", -1],
    ["1.0.0-alpha.1", "1.0.0-alpha.beta", -1],
    ["1.0.0-alpha.beta", "1.0.0-beta", -1],
    ["1.0.0-rc.1", "1.0.0-rc.1", 0],
    ["1.0.0", "1.0.0", 0],
    ["1.0.2", "1.0.10", -1],
    ["1.2.0", "1.10.0", -1],
    ["2.0.0", "1.99.99", 1],
    ["1.0.0+build.1", "1.0.0+build.2", 0],
  ] as [string, string, -1 | 0 | 1][])(
    "compares %s with %s as %i",
    (a, b, e) => {
      expect(lib.compareSemver(a, b)).toBe(e);
    },
  );

  it.each(["", "1", "1.0", "1.0.0.0", "v1.0.0", "1.0.x", "01.0.0", "abc"])(
    "throws a TypeError for the invalid version %j",
    (bad) => {
      expect(() => lib.compareSemver(bad, "1.0.0")).toThrow(TypeError);
      expect(() => lib.compareSemver("1.0.0", bad)).toThrow(TypeError);
    },
  );
});

describe("planDeprecations", () => {
  it("plans only 1.0.3 for the real-world 1.0.4 packument", () => {
    const plan = lib.planDeprecations(realWorld());
    expect(plan.refused).toBeUndefined();
    expect(plan.target).toBe("1.0.4");
    expect(plan.deprecate).toEqual([
      {
        version: "1.0.3",
        message: "Superseded by 1.0.4. Use @monte3l/groundwork@latest.",
      },
    ]);
    expect([...plan.alreadyDeprecated].sort()).toEqual(
      [
        "0.0.0",
        "0.1.0-next.0",
        "0.1.0-next.1",
        "1.0.0-rc.2",
        "1.0.0-rc.3",
        "1.0.0-rc.4",
        "1.0.0-rc.5",
        "1.0.0-rc.6",
        "1.0.0-rc.7",
        "1.0.0-rc.8",
        "1.0.0",
        "1.0.1",
        "1.0.2",
      ].sort(),
    );
  });

  it("returns an empty plan for the fully deprecated real-world packument", () => {
    const plan = lib.planDeprecations(realWorldFullyDeprecated());
    expect(plan.refused).toBeUndefined();
    expect(plan.deprecate).toEqual([]);
    expect(plan.alreadyDeprecated).toContain("1.0.3");
  });

  it("takes the package name in the message from the packument name", () => {
    const p = packument("1.0.4", { "1.0.3": undefined, "1.0.4": undefined });
    p.name = "@other/pkg";
    expect(lib.planDeprecations(p).deprecate).toEqual([
      {
        version: "1.0.3",
        message: "Superseded by 1.0.4. Use @other/pkg@latest.",
      },
    ]);
  });

  it("falls back to @monte3l/groundwork when the packument has no name", () => {
    const p = packument("1.0.4", { "1.0.3": undefined, "1.0.4": undefined });
    expect(p.name).toBeUndefined();
    expect(lib.planDeprecations(p).deprecate[0]?.message).toBe(
      "Superseded by 1.0.4. Use @monte3l/groundwork@latest.",
    );
  });

  it("selects undeprecated releases and prereleases below latest, sorted ascending", () => {
    const plan = lib.planDeprecations(
      packument("2.0.0", {
        "1.0.10": undefined,
        "1.0.2": undefined,
        "1.0.0-rc.10": undefined,
        "1.0.0-rc.2": undefined,
        "1.0.0": undefined,
        "2.0.0": undefined,
      }),
    );
    expect(plan.deprecate.map((d) => d.version)).toEqual([
      "1.0.0-rc.2",
      "1.0.0-rc.10",
      "1.0.0",
      "1.0.2",
      "1.0.10",
    ]);
    expect(
      plan.deprecate.every(
        (d) =>
          d.message === "Superseded by 2.0.0. Use @monte3l/groundwork@latest.",
      ),
    ).toBe(true);
  });

  it("never plans a version newer than latest", () => {
    const plan = lib.planDeprecations(
      packument("1.0.4", {
        "1.0.3": undefined,
        "1.0.4": undefined,
        "1.1.0": undefined,
      }),
    );
    expect(plan.deprecate.map((d) => d.version)).toEqual(["1.0.3"]);
  });

  it("returns an empty plan when nothing is left to deprecate", () => {
    const plan = lib.planDeprecations(
      packument("1.0.4", {
        "1.0.3": "Superseded by 1.0.4. Use @monte3l/groundwork@latest.",
        "1.0.4": undefined,
      }),
    );
    expect(plan.refused).toBeUndefined();
    expect(plan.target).toBe("1.0.4");
    expect(plan.deprecate).toEqual([]);
    expect(plan.alreadyDeprecated).toEqual(["1.0.3"]);
  });

  it("refuses when latest is missing", () => {
    const plan = lib.planDeprecations(
      packument(undefined, { "1.0.0": undefined }),
    );
    expect(typeof plan.refused).toBe("string");
    expect(plan.refused).not.toBe("");
    expect(plan.deprecate).toEqual([]);
  });

  it("refuses when latest is a prerelease", () => {
    const plan = lib.planDeprecations(
      packument("1.0.0-rc.8", {
        "1.0.0-rc.7": undefined,
        "1.0.0-rc.8": undefined,
      }),
    );
    expect(typeof plan.refused).toBe("string");
    expect(plan.deprecate).toEqual([]);
  });

  it("refuses when latest is itself deprecated", () => {
    const plan = lib.planDeprecations(
      packument("1.0.4", { "1.0.3": undefined, "1.0.4": "broken release" }),
    );
    expect(typeof plan.refused).toBe("string");
    expect(plan.deprecate).toEqual([]);
  });

  it("refuses when any version string is invalid", () => {
    const plan = lib.planDeprecations(
      packument("1.0.4", {
        "1.0.3": undefined,
        "not-a-version": undefined,
        "1.0.4": undefined,
      }),
    );
    expect(typeof plan.refused).toBe("string");
    expect(plan.deprecate).toEqual([]);
  });

  it("does not mutate its input", () => {
    const input = realWorld();
    const snapshot = structuredClone(input);
    lib.planDeprecations(input);
    expect(input).toEqual(snapshot);
  });
});

describe("buildDeprecateRange", () => {
  it("attaches the name to the first version and unions exact versions with ||", () => {
    expect(
      lib.buildDeprecateRange("@monte3l/groundwork", ["1.0.3", "1.0.2"]),
    ).toBe("@monte3l/groundwork@1.0.3 || 1.0.2");
  });

  it("handles a single version and prerelease versions verbatim", () => {
    expect(lib.buildDeprecateRange("pkg", ["1.0.0-rc.2"])).toBe(
      "pkg@1.0.0-rc.2",
    );
    expect(lib.buildDeprecateRange("pkg", ["1.0.0-rc.2", "1.0.0"])).toBe(
      "pkg@1.0.0-rc.2 || 1.0.0",
    );
  });

  it("lists only the planned versions, never an already-deprecated one or an operator range", () => {
    const plan = lib.planDeprecations(realWorld());
    const range = lib.buildDeprecateRange(
      "@monte3l/groundwork",
      plan.deprecate.map((d) => d.version),
    );
    expect(range).toBe("@monte3l/groundwork@1.0.3");
    expect(range).not.toMatch(/[<>~^*]/);
  });
});
