#!/usr/bin/env node
/**
 * `prepack` / `postpack` for `@monte3l/groundwork`. A published tarball cannot
 * reach outside its own package, but the CLI's data lives at the repo root
 * (`templates/`, `LICENSE`) and in a sibling package (`packages/plugin`), so
 * `vendor` copies them all in for the duration of a pack and `clean` removes
 * them again.
 *
 * `assets.ts` probes the source checkout first, so a copy left behind by a
 * pack that crashed before `postpack` is never read from inside the checkout.
 *
 * Files npm-family tooling strips from a tarball (`.gitignore`, `.npmrc`) are
 * stored under an escaped name; the name list and the mapping live in
 * `src/assets.ts` and are imported from its build, so there is one definition.
 * That means `pnpm build` must run before `pnpm pack`.
 */
import process from "node:process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(pkgRoot, "..", "..");
const vendoredDirs = [join(pkgRoot, "templates"), join(pkgRoot, "plugin")];
// The repo's own LICENSE, not this package's -- packages/cli has never had
// its own, so without this the published tarball ships with none at all
// (OpenSSF Best Practices' `license_location` is about the repo, but a
// published artifact missing its license is a real, separate packaging gap).
const vendoredLicense = join(pkgRoot, "LICENSE");

const mode = process.argv[2];

/** Recursively copies `from` to `to`, storing stripped dotfiles under their escaped names. */
function copyEscaped(from, to, escapeDotfileName) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (name === ".DS_Store") continue;
    const source = join(from, name);
    if (statSync(source).isDirectory()) {
      copyEscaped(source, join(to, name), escapeDotfileName);
    } else {
      cpSync(source, join(to, escapeDotfileName(name)));
    }
  }
}

function clean() {
  for (const dir of vendoredDirs) rmSync(dir, { recursive: true, force: true });
  rmSync(vendoredLicense, { force: true });
}

if (mode === "clean") {
  clean();
} else if (mode === "vendor") {
  const assetsBuild = join(pkgRoot, "dist", "assets.js");
  if (!existsSync(assetsBuild)) {
    console.error(
      `vendor-assets: ${assetsBuild} is missing -- run \`pnpm build\` before packing`,
    );
    process.exit(1);
  }
  const templates = join(repoRoot, "templates");
  const plugin = join(repoRoot, "packages", "plugin");
  const license = join(repoRoot, "LICENSE");
  for (const source of [
    join(templates, "core"),
    join(plugin, "skills"),
    license,
  ]) {
    if (!existsSync(source)) {
      console.error(
        `vendor-assets: ${source} is missing -- this must run from the source checkout`,
      );
      process.exit(1);
    }
  }

  const { escapeDotfileName } = await import(assetsBuild);
  clean();
  copyEscaped(templates, join(pkgRoot, "templates"), escapeDotfileName);
  copyEscaped(
    join(plugin, "skills"),
    join(pkgRoot, "plugin", "skills"),
    escapeDotfileName,
  );
  copyEscaped(
    join(plugin, "src"),
    join(pkgRoot, "plugin", "src"),
    escapeDotfileName,
  );
  cpSync(license, vendoredLicense);
} else {
  console.error("usage: vendor-assets.mjs <vendor|clean>");
  process.exit(1);
}
