import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadTsconfigChain } from "../../src/toolchain/tsconfig-chain.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tsconfig-chain-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, value: unknown): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

describe("loadTsconfigChain", () => {
  it("returns a lone file's own options", () => {
    write("tsconfig.json", { compilerOptions: { strict: true } });
    const chain = loadTsconfigChain(root, "tsconfig.json");
    expect(chain).toMatchObject({
      entry: "tsconfig.json",
      options: { strict: true },
      parsed: true,
      complete: true,
      links: [],
    });
    expect(chain.files.map((f) => f.rel)).toEqual(["tsconfig.json"]);
  });

  it("lets a child override its parent, entry file listed first", () => {
    write("base.json", { compilerOptions: { strict: true, target: "es2022" } });
    write("tsconfig.json", {
      extends: "./base.json",
      compilerOptions: { strict: false },
    });
    const chain = loadTsconfigChain(root, "tsconfig.json");
    expect(chain.options).toEqual({ strict: false, target: "es2022" });
    expect(chain.files.map((f) => f.rel)).toEqual([
      "tsconfig.json",
      "base.json",
    ]);
  });

  it("folds the array form left to right, with the file's own options last", () => {
    write("a.json", { compilerOptions: { target: "es2020", strict: true } });
    write("b.json", {
      compilerOptions: { target: "es2022", module: "nodenext" },
    });
    write("tsconfig.json", {
      extends: ["./a.json", "./b.json"],
      compilerOptions: { module: "preserve" },
    });
    expect(loadTsconfigChain(root, "tsconfig.json").options).toEqual({
      target: "es2022",
      strict: true,
      module: "preserve",
    });
  });

  it("resolves x, x.json and x/tsconfig.json for a relative specifier", () => {
    write("plain", { compilerOptions: { a: 1 } });
    write("withjson.json", { compilerOptions: { b: 2 } });
    write("dir/tsconfig.json", { compilerOptions: { c: 3 } });
    for (const [specifier, key] of [
      ["./plain", "a"],
      ["./withjson", "b"],
      ["./dir", "c"],
    ] as const) {
      write("tsconfig.json", { extends: specifier });
      const chain = loadTsconfigChain(root, "tsconfig.json");
      expect(chain.complete, specifier).toBe(true);
      expect(Object.keys(chain.options), specifier).toEqual([key]);
    }
  });

  it("finds a bare specifier under an ancestor node_modules", () => {
    write("node_modules/@acme/config/tsconfig.json", {
      compilerOptions: { strict: true },
    });
    write("packages/app/tsconfig.json", { extends: "@acme/config" });
    const chain = loadTsconfigChain(
      join(root, "packages", "app"),
      "tsconfig.json",
    );
    expect(chain.complete).toBe(true);
    expect(chain.options).toEqual({ strict: true });
    expect(chain.links[0]).toMatchObject({ kind: "package", resolved: true });
  });

  it("leaves an unresolvable bare specifier incomplete but still parsed", () => {
    write("tsconfig.json", { extends: "@tsconfig/node24/tsconfig.json" });
    const chain = loadTsconfigChain(root, "tsconfig.json");
    expect(chain.parsed).toBe(true);
    expect(chain.complete).toBe(false);
    expect(chain.links).toMatchObject([{ kind: "package", resolved: false }]);
  });

  it("marks a missing relative target incomplete and names where it looked", () => {
    write("tsconfig.json", { extends: "./gone" });
    const chain = loadTsconfigChain(root, "tsconfig.json");
    expect(chain.complete).toBe(false);
    expect(chain.links[0]?.attempted).toBe(join(root, "gone.json"));
  });

  it("records an unparseable file and marks the chain unparsed", () => {
    write("base.json", "{oops");
    write("tsconfig.json", { extends: "./base.json" });
    const chain = loadTsconfigChain(root, "tsconfig.json");
    expect(chain.parsed).toBe(false);
    expect(chain.complete).toBe(false);
    expect(chain.files.find((f) => f.rel === "base.json")?.error).toBeTypeOf(
      "string",
    );
  });

  it("records a top level that is not an object", () => {
    write("tsconfig.json", "[]");
    const chain = loadTsconfigChain(root, "tsconfig.json");
    expect(chain.parsed).toBe(false);
    expect(chain.files[0]?.error).toBe("top level is not an object");
  });

  it("survives an extends cycle", () => {
    write("a.json", { extends: "./b.json", compilerOptions: { a: 1 } });
    write("b.json", { extends: "./a.json", compilerOptions: { b: 2 } });
    const chain = loadTsconfigChain(root, "a.json");
    expect(chain.options).toEqual({ b: 2, a: 1 });
    expect(chain.files).toHaveLength(2);
  });

  it("lists a shared base once when two entries extend it", () => {
    write("base.json", { compilerOptions: { strict: true } });
    write("a.json", { extends: "./base.json" });
    write("b.json", { extends: "./base.json" });
    write("tsconfig.json", { extends: ["./a.json", "./b.json"] });
    const chain = loadTsconfigChain(root, "tsconfig.json");
    expect(chain.files.filter((f) => f.rel === "base.json")).toHaveLength(1);
    expect(chain.links.filter((l) => l.from === "a.json")).toHaveLength(1);
  });

  it("ignores extends entries that are not strings", () => {
    write("tsconfig.json", { extends: [1, null, "./ok.json"] });
    write("ok.json", { compilerOptions: { strict: true } });
    expect(loadTsconfigChain(root, "tsconfig.json").options).toEqual({
      strict: true,
    });
    write("tsconfig.json", { extends: 5 });
    expect(loadTsconfigChain(root, "tsconfig.json").complete).toBe(true);
  });
});
