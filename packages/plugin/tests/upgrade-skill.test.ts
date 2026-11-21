// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Contract pins for the /upgrade skill (`skills/upgrade/SKILL.md` and
 * `step-3-conflicts.md`): preconditions, the batch decision, the conflict
 * step, report-only classes, the stamp step and the hard rules. The skill is
 * plain markdown, so these read it at run time and pin load-bearing facts with
 * regexes over a whitespace-collapsed copy (a line wrap never breaks a pin).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const upgradeDir = join(pluginRoot, "skills", "upgrade");
const customizeDir = join(pluginRoot, "skills", "customize");

const raw = (dir: string, name: string): string =>
  readFileSync(join(dir, name), "utf8");
const collapse = (s: string): string => s.replace(/\s+/g, " ");
const skillRaw = (): string => raw(upgradeDir, "SKILL.md");
const stepRaw = (): string => raw(upgradeDir, "step-3-conflicts.md");
const skill = (): string => collapse(skillRaw());
const step3 = (): string => collapse(stepRaw());

function frontmatter(source: string): string {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
  expect(match, "SKILL.md must open with a frontmatter block").not.toBeNull();
  return match?.[1] ?? "";
}

describe("upgrade SKILL.md -- frontmatter", () => {
  it("opens with frontmatter and no license header, like /customize", () => {
    expect(skillRaw().startsWith("---\n")).toBe(true);
    expect(raw(customizeDir, "SKILL.md").startsWith("---\n")).toBe(true);
    expect(stepRaw()).not.toMatch(/SPDX-/);
  });

  it("declares name: upgrade", () => {
    expect(frontmatter(skillRaw())).toMatch(/^name:\s*upgrade\s*$/m);
  });

  it("has a non-empty single-block description under 1024 characters", () => {
    const fm = frontmatter(skillRaw());
    expect(fm.match(/^description:/gm)).toHaveLength(1);
    const lines = fm.split("\n");
    const start = lines.findIndex((l) => l.startsWith("description:"));
    const rest: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (/^\S/.test(line)) break;
      rest.push(line);
    }
    const inline = (lines[start] ?? "")
      .replace(/^description:\s*(>-?|\|-?)?/, "")
      .trim();
    const body = collapse([inline, ...rest].join(" ")).trim();
    expect(body.length).toBeGreaterThan(0);
    expect(body.length).toBeLessThan(1024);
  });

  it("names /upgrade and the trigger phrasing", () => {
    const fm = collapse(frontmatter(skillRaw()));
    expect(fm).toMatch(/\/upgrade/);
    expect(fm).toMatch(/take the new release/i);
    expect(fm).toMatch(/upgrade m3l-groundwork/i);
  });

  it("declares only keys /customize's frontmatter uses, so no allowed-tools widening", () => {
    const keys = (s: string): string[] =>
      [...frontmatter(s).matchAll(/^([A-Za-z][\w-]*):/gm)].map(
        (m) => m[1] ?? "",
      );
    const customizeKeys = keys(raw(customizeDir, "SKILL.md"));
    for (const key of keys(skillRaw())) {
      expect(customizeKeys).toContain(key);
    }
  });
});

describe("upgrade SKILL.md -- Step 0 preconditions", () => {
  it("reads the manifest, the plan and the report", () => {
    const text = skill();
    expect(text).toMatch(/\.groundwork\/manifest\.json/);
    expect(text).toMatch(/\.groundwork\/upgrade\/plan\.json/);
    expect(text).toMatch(/\.groundwork\/upgrade\/upgrade-report\.md/);
  });

  it.each([
    ["missing", /missing/i],
    [
      "unparseable",
      /unparse?able|cannot be parsed|not valid JSON|does not parse/i,
    ],
    ["schemaVersion not 1", /schemaVersion/],
    ["legacy", /legacy/i],
    ["stale plan via fromCliVersion", /fromCliVersion/],
  ])("refuses on %s", (_label, pattern) => {
    expect(skill()).toMatch(pattern);
  });

  it("ties the stale-plan check to the manifest's cliVersion", () => {
    expect(skill()).toMatch(/cliVersion/);
    expect(skill()).toMatch(/stale/i);
  });

  it("says a legacy plan is not supported yet", () => {
    expect(skill()).toMatch(/legacy[^.]*(not supported|unsupported)/i);
  });

  it("tells the user to run the exact re-plan command and stops, writing nothing", () => {
    const text = skill();
    expect(text).toContain("npx @monte3l/groundwork@latest --upgrade .");
    expect(text).toMatch(/stop/i);
    expect(text).toMatch(/(writ(e|ing) nothing|change nothing)/i);
  });

  it("requires a clean git working tree for the plan's paths, else asks to commit or stash and stops", () => {
    const text = skill();
    expect(text).toMatch(/clean/i);
    expect(text).toMatch(/working tree/i);
    expect(text).toMatch(/commit or stash|stash or commit/i);
  });
});

describe("upgrade SKILL.md -- Step 1 summary and release notes", () => {
  it("summarises the plan by class counts", () => {
    expect(skill()).toMatch(/count/i);
    expect(skill()).toMatch(/class/i);
  });

  it("quotes GitHub Releases between fromCliVersion and toCliVersion via gh", () => {
    const text = skill();
    expect(text).toMatch(/GitHub Releases/i);
    expect(text).toMatch(/\bgh\b/);
    expect(text).toMatch(/toCliVersion/);
  });

  it("says plainly when notes cannot be fetched and never fabricates CHANGELOG content", () => {
    const text = skill();
    expect(text).toMatch(/(offline|no `?gh`?|not available|unavailable)/i);
    expect(text).toMatch(/(never|do not|don't)[^.]*(invent|fabricat|make up)/i);
    expect(text).toMatch(/CHANGELOG/);
  });
});

describe("upgrade SKILL.md -- Step 2 batch decision", () => {
  it("asks one batch decision through AskUserQuestion", () => {
    expect(skill()).toMatch(/AskUserQuestion/);
    expect(skill()).toMatch(/batch/i);
  });

  it("applies safe-update and add from staged/<path>.staged and removes remove-class files", () => {
    const text = skill();
    expect(text).toMatch(/safe-update/);
    expect(text).toMatch(/`?add`?/);
    expect(text).toMatch(/\.groundwork\/upgrade\/staged\/<path>\.staged/);
    expect(text).toMatch(/\bremove\b/);
    expect(text).toMatch(/delete/i);
  });

  it("never edits or deletes a path outside plan.json's files", () => {
    expect(skill()).toMatch(
      /(never|not)[^.]*(edit|delete|touch)[^.]*(not in|outside)[^.]*(plan\.json|files)/i,
    );
  });

  it("never touches the manifest itself; the CLI writes it", () => {
    expect(skill()).toMatch(
      /(never|not)[^.]*(touch|edit|write|modify)[^.]*manifest\.json/i,
    );
    expect(skill()).toMatch(/CLI writes|written by the CLI|CLI owns/i);
  });

  it("never records a hash and never writes manifest.json, but allows a read-only shasum -a 256 check", () => {
    const text = skill();
    expect(text).toMatch(/never[^.]*record[^.]*hash/i);
    expect(text).toMatch(/CLI records/i);
    expect(text).toMatch(/shasum -a 256/);
    expect(text).not.toMatch(/never[^.]*comput(e|es|ing)[^.]*hash/i);
  });

  it("handles JSON files key by key using jsonKeys", () => {
    const text = skill();
    expect(text).toMatch(/jsonKeys/);
    expect(text).toMatch(/key by key|per key|key-by-key/i);
    for (const file of ["package.json", "tsconfig", ".claude/settings.json"]) {
      expect(text).toContain(file);
    }
  });
});

describe("upgrade SKILL.md -- Step 3 pointer", () => {
  it("links step-3-conflicts.md", () => {
    expect(skill()).toContain("step-3-conflicts.md");
  });

  it("says to read it in full before acting and again after any compaction", () => {
    const text = skill();
    expect(text).toMatch(
      /read[^.]*(in full|whole|entire)[^.]*step-3-conflicts\.md|step-3-conflicts\.md[^.]*(in full|whole file|entire)/i,
    );
    expect(text).toMatch(/compaction/i);
  });
});

describe("step-3-conflicts.md -- conflict resolution", () => {
  it("covers both conflict classes", () => {
    expect(step3()).toMatch(/conflict-3way/);
    expect(step3()).toMatch(/conflict-2way/);
  });

  it.each(["keep", "take", "delegate"])("offers the %s resolution", (word) => {
    expect(step3()).toMatch(new RegExp(`\`${word}\``));
  });

  it("explains keep, take and delegate", () => {
    const text = step3();
    expect(text).toMatch(/keep[^.]*(project|your)/i);
    expect(text).toMatch(/take[^.]*staged/i);
    expect(text).toMatch(/delegate[^.]*merges?/i);
    expect(text).toMatch(
      /(confirm|confirmation)[^.]*before writ|before writ[^.]*(confirm|confirmation)/i,
    );
  });

  it("records decisions in decisions.json as {path, resolution} after each answer", () => {
    const text = step3();
    expect(text).toContain(".groundwork/upgrade/decisions.json");
    expect(text).toMatch(/JSON array/i);
    expect(text).toMatch(/path/);
    expect(text).toMatch(/resolution/);
    expect(text).toMatch(/(after each|after every|each answer)/i);
  });

  it("re-reads decisions.json after a compaction so answered paths are never re-asked", () => {
    const text = step3();
    expect(text).toMatch(/compaction/i);
    expect(text).toMatch(/re-?read/i);
    expect(text).toMatch(/(never|not)[^.]*re-?ask/i);
  });

  it("rebuilds the old base for a 3-way delegate with the pinned fresh command", () => {
    const text = step3();
    expect(text).toMatch(
      /npx --yes @monte3l\/groundwork@<fromCliVersion> --fresh --skip-install --name <PROJECT_NAME>/,
    );
    expect(text).toMatch(/--pack <name>/);
    expect(text).toMatch(/temp(orary)? dir/i);
    expect(text).toMatch(/manifest/i);
    expect(text).toMatch(/base[^.]*(yours|your)[^.]*new|three[- ]way/i);
    expect(text).toMatch(/\bonce\b/i);
  });

  it("falls back to a two-way comparison when the base cannot be rebuilt, saying so", () => {
    const text = step3();
    expect(text).toMatch(
      /(offline|unpublished|fails|cannot be (fetched|run))/i,
    );
    expect(text).toMatch(/two-way/i);
    expect(text).toMatch(/(say|tell|state)[^.]*(so|that|plainly)/i);
  });

  it("treats conflict-2way as always two-way", () => {
    expect(step3()).toMatch(
      /conflict-2way[^.]*(always )?two-way|two-way[^.]*conflict-2way/i,
    );
  });

  it("never writes outside the plan's paths", () => {
    expect(step3()).toMatch(
      /(never|not)[^.]*(writ|edit)[^.]*(outside|not in)[^.]*plan/i,
    );
  });
});

describe("upgrade SKILL.md -- report-only classes", () => {
  it.each(["user-deleted", "orphan-edited", "local-only", "gone", "current"])(
    "lists %s as report-only",
    (cls) => {
      expect(skill()).toContain(cls);
    },
  );

  it("takes no action on them and never deletes an orphan-edited file", () => {
    const text = skill();
    expect(text).toMatch(/(report-only|no action|only reported|listed)/i);
    expect(text).toMatch(
      /(never|not)[^.]*delet[^.]*orphan-edited|orphan-edited[^.]*(never|not)[^.]*delet/i,
    );
  });
});

describe("upgrade SKILL.md -- Step 4 stamp and verify", () => {
  it("runs the stamp command", () => {
    expect(skill()).toContain(
      "npx --yes @monte3l/groundwork@<toCliVersion> --upgrade --stamp .",
    );
  });

  it("never stamps with @latest", () => {
    expect(skill()).not.toMatch(/--stamp[^.]*@latest|@latest[^.]*--stamp/);
  });

  it("keeps applied files when stamp refuses; a re-run shows them as current", () => {
    expect(skill()).toMatch(
      /stamp[^.]*refus[^.]*(stay|remain|keep|kept)|(stay|remain|kept)[^.]*stamp[^.]*refus/i,
    );
    expect(skill()).toMatch(/current/);
  });

  it("takes the already-stamped shortcut only when fromCliVersion differs from toCliVersion and the manifest already equals toCliVersion", () => {
    expect(skill()).toMatch(
      /fromCliVersion[^.]*(differs|differ|is not equal|!=)[^.]*toCliVersion[^.]*(and|,)[^.]*cliVersion[^.]*(equals|already)[^.]*toCliVersion/i,
    );
    expect(skill()).toMatch(
      /(from|fromCliVersion)[^.]*(and|equal)[^.]*(to|toCliVersion)[^.]*(equal|same)[^.]*(applied|apply)[^.]*normally/i,
    );
  });

  it("goes straight to Step 4's checks when the manifest already equals toCliVersion", () => {
    expect(skill()).toMatch(
      /already stamped|cliVersion[^.]*(equals|matches|is already)[^.]*toCliVersion/i,
    );
    expect(skill()).toMatch(/straight to[^.]*(Step 4|checks)/i);
  });

  it("runs pnpm install when package.json changed, then pnpm verify when present", () => {
    const text = skill();
    expect(text).toMatch(/pnpm install/);
    expect(text).toMatch(
      /package\.json[^.]*(changed|touched)|(changed|touched)[^.]*package\.json/i,
    );
    expect(text).toMatch(/pnpm verify/);
    expect(text.indexOf("--upgrade --stamp")).toBeLessThan(
      text.indexOf("pnpm verify"),
    );
  });

  it("runs the project's harness and toolchain checks when present", () => {
    expect(skill()).toMatch(/check-harness|check:harness/);
    expect(skill()).toMatch(/check-toolchain|check:toolchain/);
  });

  it("suggests a commit message but never commits, pushes or opens a PR", () => {
    const text = skill();
    expect(text).toMatch(/commit message/i);
    expect(text).toMatch(/(never|not)[^.]*commit/i);
    expect(text).toMatch(/push/i);
    expect(text).toMatch(/pull request|\bPR\b/);
  });
});

describe("upgrade SKILL.md -- hard rules", () => {
  it("has a hard rules section", () => {
    expect(skillRaw()).toMatch(/^#{1,4} .*hard rules/im);
  });

  it("limits the network to npx and gh, forbids git writes, and says to stop and ask on surprise", () => {
    const text = skill();
    const start = text.search(/#{1,4} [^#]*hard rules/i);
    expect(start).toBeGreaterThan(-1);
    const rules = text.slice(start);
    expect(rules).toMatch(/network/i);
    expect(rules).toMatch(/npx/);
    expect(rules).toMatch(/\bgh\b/);
    expect(rules).toMatch(/git/i);
    expect(rules).toMatch(/(stop and ask|stop, and ask|ask the user)/i);
    expect(rules).toMatch(/surprise|unexpected/i);
  });
});

describe("upgrade skill -- size and shape", () => {
  it("keeps SKILL.md and the step file under 40000 characters", () => {
    expect(skillRaw().length).toBeLessThan(40000);
    expect(stepRaw().length).toBeLessThan(40000);
  });

  it("keeps SKILL.md smaller than /customize's SKILL.md", () => {
    expect(skillRaw().length).toBeLessThan(
      raw(customizeDir, "SKILL.md").length,
    );
  });

  it.each([skillRaw, stepRaw])("ends with exactly one newline", (get) => {
    const text = get();
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });

  it("links only to sibling .md files that exist", () => {
    const targets = [...skillRaw().matchAll(/\]\(([^)#/\s]+\.md)\)/g)].map(
      (m) => m[1] as string,
    );
    expect(targets).toContain("step-3-conflicts.md");
    for (const target of targets) {
      expect(() =>
        readFileSync(join(upgradeDir, target), "utf8"),
      ).not.toThrow();
    }
  });
});

describe("plugin packaging mentions /upgrade", () => {
  it("names /upgrade in .claude-plugin/plugin.json's description", () => {
    const manifest = JSON.parse(
      readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"),
    ) as { description: string };
    expect(manifest.description).toContain("/upgrade");
    expect(manifest.description).toContain("/customize");
  });

  it("names /upgrade in package.json's description", () => {
    const pkg = JSON.parse(
      readFileSync(join(pluginRoot, "package.json"), "utf8"),
    ) as { description: string };
    expect(pkg.description).toContain("/upgrade");
  });

  it("names /upgrade in the README", () => {
    expect(readFileSync(join(pluginRoot, "README.md"), "utf8")).toContain(
      "/upgrade",
    );
  });
});

const both = (): string => `${skill()} ${step3()}`;

describe("upgrade skill -- drift check before any write or delete", () => {
  it("confirms the target still matches the plan with shasum -a 256 against currentSha256", () => {
    const text = skill();
    expect(text).toMatch(/drift/i);
    expect(text).toMatch(/shasum -a 256 <path>/);
    expect(text).toMatch(/currentSha256/);
  });

  it("requires the target of an add to be absent", () => {
    expect(skill()).toMatch(/`?add`?[^.]*(absent|not exist|does not exist)/i);
  });

  it("stops on any mismatch and tells the user to re-plan", () => {
    expect(skill()).toMatch(/mismatch/i);
    expect(skill()).toMatch(/re-?plan/i);
  });

  it("applies to both the batch and the conflicts step", () => {
    expect(skill()).toMatch(
      /(batch|Step 2)[^.]*(drift|shasum)|(drift|shasum)[^.]*(batch|Step 2)/i,
    );
    expect(step3()).toMatch(/drift|shasum -a 256|currentSha256/i);
  });
});

describe("upgrade skill -- resume", () => {
  it("still runs the clean-tree check over plan paths neither decisions.json nor applied.json lists", () => {
    const text = skill();
    expect(text).toMatch(/resum/i);
    expect(text).toMatch(/applied\.json/);
    expect(text).toMatch(
      /(neither|not listed|unlisted|does not list|no[^.]* lists?)/i,
    );
    expect(text).toMatch(
      /only (the )?listed paths|listed paths[^.]*(dirty|may be)/i,
    );
  });

  it("confirms each recorded entry is on disk and asks the user when not", () => {
    const text = skill();
    expect(text).toMatch(/(staged bytes|on disk)/i);
    expect(text).toMatch(/absent[^.]*remove|remove[^.]*absent/i);
    expect(text).toMatch(/ask the user|AskUserQuestion/i);
  });
});

describe("upgrade skill -- JSON files with jsonKeys", () => {
  it("never replaces the whole file; take and delegate act only on the listed keys", () => {
    const text = both();
    expect(text).toMatch(/never replace[^.]*(whole|entire) file/i);
    expect(text).toMatch(
      /(take|delegate)[^.]*only[^.]*(listed )?keys|only[^.]*(listed )?keys[^.]*(take|delegate)/i,
    );
  });

  it("with no key conflict applies the batch keys, records keep and says the rest is outside the baseline's keys", () => {
    const text = both();
    expect(text).toMatch(/no key conflicts?/i);
    expect(text).toMatch(/outside the keys the baseline manages/i);
    expect(text).toMatch(/records? `?keep`?/i);
  });

  it("states JSON Pointer semantics: ~1 decodes to /, ~0 to ~, ~1 first", () => {
    const text = both();
    expect(text).toContain("~1");
    expect(text).toContain("~0");
    expect(text).toMatch(/~1[^.]*first|first[^.]*~1/i);
    expect(text).toMatch(/JSON Pointer/i);
  });

  it("takes the staged copy's whole value at the pointer, creates a missing parent for add, and treats /x as an empty object", () => {
    const text = both();
    expect(text).toMatch(/whole value/i);
    expect(text).toMatch(
      /parent[^.]*(missing|absent)[^.]*creat|creat[^.]*parent/i,
    );
    expect(text).toMatch(/empty object/i);
  });
});

describe("upgrade skill -- when to record", () => {
  it("records a path only after its write or delete has finished, keep immediately", () => {
    const text = both();
    expect(text).toMatch(
      /only after[^.]*(write|delete)[^.]*(finish|complet|done)|after[^.]*(write|delete)[^.]*has finished/i,
    );
    expect(text).toMatch(/keep[^.]*immediately|immediately[^.]*keep/i);
  });

  it("never records delegate until the confirmed merge is written", () => {
    expect(step3()).toMatch(
      /never record[^.]*delegate[^.]*(until|before)[^.]*(merge|written)|delegate[^.]*never record[^.]*until/i,
    );
  });

  it("leaves the keys of a conflicting JSON file to Step 3, which applies them with the resolution in one write and records one entry", () => {
    expect(skill()).toMatch(
      /(Step 2|batch)[^.]*(does not|never|not)[^.]*(apply|touch)[^.]*keys of a conflicting JSON file|keys of a conflicting JSON file[^.]*(not|never)[^.]*(batch|Step 2)/i,
    );
    expect(step3()).toMatch(
      /(together with|along with|with) the (chosen )?resolution[^.]*(one|single) write|(one|single) write[^.]*(resolution|keys)/i,
    );
    expect(step3()).toMatch(
      /(one|single) `?decisions\.json`? entry|records? (one|a single) (entry|decision)/i,
    );
  });
});

describe("upgrade skill -- decisions.json and applied.json", () => {
  it("keeps conflict resolutions in decisions.json and batch progress in applied.json", () => {
    const text = both();
    expect(text).toContain(".groundwork/upgrade/decisions.json");
    expect(text).toContain(".groundwork/upgrade/applied.json");
    expect(text).toMatch(
      /applied\.json[^.]*JSON array of paths|JSON array of paths[^.]*applied\.json/i,
    );
  });

  it("types resolutions as keep|take|delegate and never lists safe-update, add or remove paths in decisions.json", () => {
    const text = both();
    expect(text).toMatch(
      /keep\s*\|\s*take\s*\|\s*delegate|keep, take(,)? or delegate/i,
    );
    expect(text).toMatch(
      /decisions\.json[^.]*(only|never)[^.]*(conflict|safe-update|add)|(only|never)[^.]*decisions\.json[^.]*(conflict|safe-update)/i,
    );
    expect(text).toMatch(
      /never list[^.]*(safe-update|batch)|only conflict resolutions/i,
    );
  });
});

describe("upgrade skill -- preconditions added in round 2", () => {
  it("refuses when the project is not a git repository", () => {
    expect(skill()).toMatch(
      /not a git repository|not inside a git repository|no git repository/i,
    );
  });

  it("requires every staged value to point inside .groundwork/upgrade/staged/ before copying", () => {
    expect(skill()).toMatch(
      /staged[^.]*(inside|within|under)[^.]*\.groundwork\/upgrade\/staged\//i,
    );
  });
});

describe("upgrade skill -- symlink refusal", () => {
  it("requires an add target to be absent and not a symlink", () => {
    expect(both()).toContain("[ ! -e <path> ] && [ ! -L <path> ]");
  });

  it("requires every existing ancestor directory to be a real directory, not a symlink", () => {
    expect(both()).toContain("[ -d <dir> ] && [ ! -L <dir> ]");
  });

  it("requires any other target to be a regular file, not a symlink, before shasum, else stops", () => {
    const text = both();
    expect(text).toContain("[ -f <path> ] && [ ! -L <path> ]");
    expect(text).toMatch(/symlink/i);
    expect(text).toMatch(/before[^.]*shasum|shasum[^.]*after/i);
  });
});

describe("upgrade skill -- malformed progress files", () => {
  it("stops and asks when decisions.json or applied.json does not parse or has the wrong shape, never repairing it", () => {
    const text = both();
    expect(text).toMatch(/does not parse|unparseable|cannot be parsed/i);
    expect(text).toMatch(/never (rewrite|repair|discard)/i);
    expect(text).toMatch(/repair/i);
    expect(text).toMatch(/discard/i);
  });

  it.each([
    ["a path listed twice", /(twice|duplicate)/i],
    ["a path not in the plan's files", /not in[^.]*files/i],
    ["a class mismatch", /class[^.]*(does not match|mismatch)/i],
    ["a resolution outside keep|take|delegate", /outside[^.]*keep/i],
  ])("treats %s as a wrong shape", (_label, pattern) => {
    expect(both()).toMatch(pattern);
  });
});

describe("upgrade skill -- ordering and references", () => {
  it("runs the batch's remove deletions after Step 3", () => {
    expect(skill()).toMatch(
      /remove[^.]*(after|only after)[^.]*Step 3|after Step 3[^.]*remove/i,
    );
  });

  it("searches .claude/settings.json and package.json for a path before deleting it and warns if still referenced", () => {
    const text = skill();
    expect(text).toMatch(
      /search[^.]*\.claude\/settings\.json[^.]*package\.json/i,
    );
    expect(text).toMatch(/warn[^.]*referenc|referenc[^.]*warn/i);
  });
});

describe("upgrade skill -- read-only hashing and staged copy", () => {
  it("says the only hashing is read-only shasum -a 256 checks, and resume confirms with cmp -s", () => {
    const text = skill();
    expect(text).toMatch(
      /only hashing[^.]*shasum -a 256|read-only `?shasum -a 256`?/i,
    );
    expect(text).toMatch(/read-only/i);
    expect(text).toContain("cmp -s");
  });

  it("takes the plan's staged entry matching the path, joins it to .groundwork/upgrade/, stops with no entry, and verifies sha256 before copying", () => {
    const text = skill();
    expect(text).toMatch(/staged[^.]*entry[^.]*path/i);
    expect(text).toMatch(/join[^.]*\.groundwork\/upgrade\//i);
    expect(text).toMatch(/no entry|no matching entry|is no/i);
    expect(text).toMatch(/sha256[^.]*shasum -a 256|shasum -a 256[^.]*sha256/i);
    expect(text).toMatch(/before copying/i);
  });

  it("limits writes to safe-update, add, remove and conflict paths, naming the classes it never writes", () => {
    const text = skill();
    expect(text).toMatch(
      /conflict-3way[^.]*conflict-2way|conflict-2way[^.]*conflict-3way/,
    );
    for (const cls of [
      "current",
      "local-only",
      "user-deleted",
      "orphan-edited",
      "gone",
    ]) {
      expect(text).toContain(cls);
    }
    expect(text).toMatch(
      /(only|never)[^.]*(write|edit)[^.]*(safe-update|class)/i,
    );
  });
});

describe("upgrade skill -- npx failure and current-state claim", () => {
  it("stops with the files applied but NOT stamped when npx cannot fetch the stamp release, never swapping versions", () => {
    const text = skill();
    expect(text).toMatch(/NOT stamped/);
    expect(text).toMatch(/(offline|unpublished|local build)/i);
    expect(text).toMatch(
      /never (swap|substitute|use another)[^.]*version|another version/i,
    );
  });

  it("limits 're-running shows current' to files whose bytes equal the new release's; kept or merged files show as conflicts again", () => {
    const text = skill();
    expect(text).toMatch(/bytes[^.]*(equal|match)[^.]*(new )?release/i);
    expect(text).toMatch(
      /(kept|merged)[^.]*conflict[^.]*again|conflicts? again/i,
    );
  });
});

describe("upgrade skill -- clean tree details", () => {
  it("mentions git check-ignore for gitignored managed paths and asks first", () => {
    const text = skill();
    expect(text).toContain("git check-ignore");
    expect(text).toMatch(/(ask first|ask the user first|ask before)/i);
  });

  it("refuses an untracked conflict file (??)", () => {
    expect(skill()).toMatch(/\?\?/);
    expect(skill()).toMatch(/untracked[^.]*conflict|conflict[^.]*untracked/i);
  });
});

describe("upgrade skill -- JSON definition, empty object, resume and alerts", () => {
  it("defines a JSON file as one with an entry in jsonKeys, not a fixed list of names", () => {
    expect(both()).toMatch(/(a file with|with) an entry in `?jsonKeys`?/i);
  });

  it("describes an empty-object entry as a pointer to a top-level key whose value is {}", () => {
    expect(both()).toMatch(
      /pointer to a top-level key whose value is `?\{\}`?/i,
    );
  });

  it("offers a batch path the user declined again on resume", () => {
    expect(skill()).toMatch(
      /declined[^.]*(again|re-?offer)|(again|re-?offer)[^.]*declined/i,
    );
  });

  it("uses a GitHub IMPORTANT alert in both SKILL.md and step-3-conflicts.md", () => {
    expect(skillRaw()).toMatch(/^> \[!IMPORTANT\]/m);
    expect(stepRaw()).toMatch(/^> \[!IMPORTANT\]/m);
  });
});

describe("upgrade skill -- hard rules carve-out and base rebuild", () => {
  it("lets Step 4's pnpm install and pnpm verify write the lockfile, node_modules and build output", () => {
    const text = skill();
    const start = text.search(/#{1,4} [^#]*hard rules/i);
    expect(start).toBeGreaterThan(-1);
    const rules = text.slice(start);
    expect(rules).toMatch(/lockfile/i);
    expect(rules).toMatch(/node_modules/);
    expect(rules).toMatch(/build output/i);
    expect(rules).toMatch(/decisions\.json/);
    expect(rules).toMatch(/applied\.json/);
  });

  it("rebuilds into a path that does not exist yet inside a fresh mktemp -d directory", () => {
    const text = step3();
    expect(text).toContain("mktemp -d");
    expect(text).toMatch(
      /(does not exist yet|not exist yet|new path|non-?existent)/i,
    );
  });

  it("notes the rebuild runs git init and a failing git init does not spoil the base when the files exist", () => {
    const text = step3();
    expect(text).toMatch(/git init/);
    expect(text).toMatch(
      /(fail|fails|failing)[^.]*git init|git init[^.]*(fail|fails|failing)/i,
    );
    expect(text).toMatch(/files exist|files are (there|present)/i);
  });

  it("limits the year caveat to the copyright and year lines where the template year was rendered", () => {
    const text = step3();
    expect(text).toMatch(/year/i);
    expect(text).toMatch(/copyright/i);
    expect(text).toMatch(
      /(do not|never|don't)[^.]*substitut[^.]*(other|any other) number|only[^.]*(copyright|year) lines/i,
    );
  });

  it("does not call the staged-vs-current diff what changed upstream; both sides' changes are mixed and only the rebuilt base separates them", () => {
    const text = step3();
    expect(text).toMatch(
      /both sides'? changes[^.]*mixed|mixed[^.]*both sides/i,
    );
    expect(text).toMatch(
      /only the rebuilt base separates|rebuilt base[^.]*(only|alone)[^.]*separat|only[^.]*base[^.]*separat/i,
    );
    expect(text).not.toMatch(/what changed upstream/i);
  });
});
