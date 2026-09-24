/**
 * Proves the *published* artifact works, which nothing else here does: every
 * other test runs the CLI from the source checkout, where the data trees sit
 * three directories up. This one packs the CLI exactly as a release would,
 * unpacks the tarball into a directory outside the repository, and runs it
 * from there -- the only layout in which a broken asset path, a `files`
 * entry that matches nothing, or a stripped dotfile can show up.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliDir = join(here, "..");
const checkoutBin = join(cliDir, "bin", "m3l-groundwork.mjs");

/** Every file under `dir` (relative paths), skipping git internals. */
function listFiles(dir: string, root: string = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === ".git") return [];
    const full = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full, root) : [relative(root, full)];
  });
}

describe("published tarball end-to-end", () => {
  let scratch: string;
  let installedBin: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "m3l-pack-e2e-"));
    // `pnpm pack` runs prepack (vendors templates/ and the plugin payload in)
    // and postpack (removes them) -- the same lifecycle a release goes through.
    // It needs `pnpm build` to have run, like every other e2e test here.
    execFileSync("pnpm", ["pack", "--pack-destination", scratch], {
      cwd: cliDir,
      stdio: "pipe",
    });
    const tarball = readdirSync(scratch).find((name) => name.endsWith(".tgz"));
    if (tarball === undefined) {
      throw new Error("pnpm pack produced no tarball");
    }
    const extracted = join(scratch, "extracted");
    execFileSync("mkdir", ["-p", extracted]);
    execFileSync("tar", ["xzf", join(scratch, tarball), "-C", extracted]);
    installedBin = join(extracted, "package", "bin", "m3l-groundwork.mjs");
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("removes its vendored copies from the checkout once packing finishes", () => {
    expect(existsSync(join(cliDir, "templates"))).toBe(false);
    expect(existsSync(join(cliDir, "plugin"))).toBe(false);
  });

  it("lists both packs from the vendored templates/packs", () => {
    const output = execFileSync("node", [installedBin, "--list-packs"], {
      encoding: "utf8",
    });

    expect(output).toContain("harness-extras");
    expect(output).toContain("statusline");
  });

  it("emits exactly what the source checkout emits, dotfiles included", () => {
    const fromTarball = join(scratch, "from-tarball");
    const fromCheckout = join(scratch, "from-checkout");
    const args = [
      "--name",
      "pack-e2e",
      "--skip-install",
      "--pack",
      "statusline",
    ];

    execFileSync("node", [installedBin, fromTarball, ...args], {
      stdio: "pipe",
    });
    execFileSync("node", [checkoutBin, fromCheckout, ...args], {
      stdio: "pipe",
    });

    const tarballFiles = listFiles(fromTarball).sort();
    expect(tarballFiles).toEqual(listFiles(fromCheckout).sort());

    // npm strips these names from a tarball, so they travel escaped and must
    // come out with their real names -- and never with the escaped ones.
    expect(tarballFiles).toContain(".gitignore");
    expect(tarballFiles).toContain(".npmrc");
    expect(tarballFiles).not.toContain("_gitignore");
    expect(tarballFiles).not.toContain("_npmrc");
    expect(tarballFiles).toContain(
      join(".claude", "skills", "customize", "SKILL.md"),
    );

    for (const file of tarballFiles) {
      expect(readFileSync(join(fromTarball, file), "utf8"), file).toBe(
        readFileSync(join(fromCheckout, file), "utf8"),
      );
    }
  });

  it("adopts an existing project, comparing against the real dotfile names", () => {
    const project = join(scratch, "project");
    execFileSync(
      "node",
      [checkoutBin, project, "--name", "pack-e2e", "--skip-install"],
      { stdio: "pipe" },
    );

    execFileSync("node", [installedBin, project], { stdio: "pipe" });

    const inventory = JSON.parse(
      readFileSync(join(project, ".groundwork", "inventory.json"), "utf8"),
    ) as { conflicts: { relPath: string; status: string }[] };
    const byPath = new Map(
      inventory.conflicts.map((entry) => [entry.relPath, entry.status]),
    );

    // Compared against the project's own .gitignore -- `absent` would mean
    // the walker looked for a literal `_gitignore` instead.
    expect(byPath.get(".gitignore")).toBe("identical");
    expect(byPath.get(".npmrc")).toBe("identical");
    expect(byPath.has("_gitignore")).toBe(false);
  });
});
