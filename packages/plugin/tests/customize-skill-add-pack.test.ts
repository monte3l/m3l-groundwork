// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Guards the load-bearing clauses of the `/customize add-pack` entry
 * (#377, slice 5): the router in `SKILL.md`, the scoped procedure in
 * `add-pack.md`, the installed-packs ledger step and the generalised preface
 * in `pack-install.md`, the add-pack-only `.groundwork/` classification in
 * `step-0-reconcile.md`, and the rewritten recipe in `step-3-round-1.md`.
 * Matching is done against whitespace-collapsed copies so a phrase doesn't
 * break on the markdown's own line wrapping. A missing file reads as "" so
 * only the assertions that need its text fail. Byte identity with the
 * `.claude/skills/customize/` copy is covered by
 * `customize-skill-sync.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const skillDir = join(here, "..", "skills", "customize");

function read(name: string): string {
  const path = join(skillDir, name);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}
function flatten(source: string): string {
  return source.replace(/\s+/g, " ");
}

const skillRaw = read("SKILL.md");
const skill = flatten(skillRaw);
const addPackPath = join(skillDir, "add-pack.md");
const addPack = flatten(read("add-pack.md"));
const packInstall = flatten(read("pack-install.md"));
const step0 = flatten(read("step-0-reconcile.md"));
const step3 = flatten(read("step-3-round-1.md"));

/** Text within `radius` characters either side of every occurrence of `needle`. */
function windowsAround(haystack: string, needle: string, radius: number) {
  const windows: string[] = [];
  let from = haystack.indexOf(needle);
  while (from !== -1) {
    windows.push(
      haystack.slice(Math.max(0, from - radius), from + needle.length + radius),
    );
    from = haystack.indexOf(needle, from + needle.length);
  }
  return windows;
}

describe("SKILL.md -- the add-pack router", () => {
  const frontmatter = skillRaw.slice(0, skillRaw.indexOf("\n---", 4));
  const step0Heading = skillRaw.indexOf("## Step 0");
  const routerStart = skillRaw.indexOf("$ARGUMENTS");
  const router = flatten(skillRaw.slice(routerStart, step0Heading));

  it('declares argument-hint: "[add-pack <name> ...]" in the frontmatter', () => {
    expect(frontmatter).toContain('argument-hint: "[add-pack <name> ...]"');
  });

  it("mentions adding a pack to an already-set-up project in the frontmatter description", () => {
    expect(flatten(frontmatter)).toMatch(/add a pack/i);
  });

  it("places the router (it reads $ARGUMENTS) before Step 0", () => {
    expect(step0Heading).toBeGreaterThan(-1);
    expect(routerStart).toBeGreaterThan(-1);
    expect(routerStart).toBeLessThan(step0Heading);
  });

  it("routes when $ARGUMENTS starts with add-pack", () => {
    expect(router).toMatch(/\$ARGUMENTS[^.]*starts with[^.]*add-pack/);
  });

  it("reads add-pack.md in full via a same-directory link", () => {
    expect(skillRaw).toContain("(add-pack.md)");
    expect(router).toMatch(/read \[`add-pack\.md`\]\(add-pack\.md\) in full/i);
  });

  it("follows ONLY add-pack.md and skips Steps 0-7 entirely", () => {
    expect(router).toMatch(/follow only/i);
    expect(router).toMatch(/skip Steps 0\s*(-|–|—|through|to)\s*7 entirely/i);
  });

  it("otherwise continues with the normal flow below", () => {
    expect(router).toMatch(/otherwise,? continue below/i);
  });

  it("keeps the router small (about 600 bytes; between 300 and 1000)", () => {
    const bytes = Buffer.byteLength(router, "utf8");
    expect(bytes).toBeGreaterThan(300);
    expect(bytes).toBeLessThanOrEqual(1000);
  });

  it("stays at most 18000 bytes with the router in", () => {
    expect(Buffer.byteLength(skillRaw, "utf8")).toBeLessThanOrEqual(18000);
  });
});

describe("SKILL.md -- Step 0 outline and Step 7 .groundwork/ handling", () => {
  const step7 = skill.slice(skill.indexOf("## Step 7"));
  const outline = skill.slice(
    skill.indexOf("1. Look for `.groundwork/inventory.json`."),
    skill.indexOf("2. **The deep read.**"),
  );

  it("extends the recommended .gitignore block with !.groundwork/installed-packs.json (the ledger is tracked)", () => {
    const block = /```gitignore\n([\s\S]*?)```/.exec(skillRaw)?.[1] ?? "";
    expect(block).toContain(".groundwork/*");
    expect(block).toContain("!.groundwork/adoption-report.md");
    expect(block).toContain("!.groundwork/customization-report.md");
    expect(block.split("\n")).toContain("!.groundwork/installed-packs.json");
  });

  it("says a teammate's clone holds the two reports and the ledger", () => {
    expect(step7).toContain("the two reports and the ledger");
  });

  it("makes an add-pack-only .groundwork/ the exception to the 'interrupted adopt run' sentence in Step 7", () => {
    const windows = windowsAround(step7, "interrupted adopt run", 300);
    expect(windows.length).toBeGreaterThan(0);
    expect(windows.some((w) => w.includes("add-pack"))).toBe(true);
  });

  it("words the add-pack-only case as 'nothing but' the two entries, not 'holding only' (which reads as requiring both)", () => {
    expect(outline).toMatch(
      /nothing but[^.]*`add-pack\/`[^.]*`installed-packs\.json`/i,
    );
    expect(outline).not.toMatch(/holding only `add-pack\/`/);
  });

  it("makes an add-pack-only .groundwork/ an exception in the Step 0 outline too, not an interrupted CLI run", () => {
    expect(outline.length).toBeGreaterThan(0);
    expect(outline).toContain("add-pack");
  });
});

describe("add-pack.md -- existence and framing", () => {
  it("exists beside SKILL.md", () => {
    expect(existsSync(addPackPath)).toBe(true);
  });

  it("tells the agent to read the whole file, like the other step files", () => {
    expect(addPack).toMatch(/Read this whole file/);
  });
});

describe("add-pack.md -- each clause of the scoped procedure", () => {
  // Each row pins one clause: deleting that sentence from add-pack.md fails it.
  it.each([
    [
      "parses names that match ^[a-z][a-z0-9-]*$",
      /names? (must )?match(es)? `\^\[a-z\]\[a-z0-9-\]\*\$`/,
    ],
    ["sorts and de-duplicates the names", /sorted,? (and )?de-duplicated/],
    [
      "with no names given, asks which staged packs under .groundwork/add-pack/ to install, listing them",
      /(none|no names?) (is |are )?given[^.]*(ask|asks)[^.]*\.groundwork\/add-pack\//i,
    ],
    [
      "requires .groundwork/add-pack/<name>/plan.json for each pack",
      /require[^.]*`\.groundwork\/add-pack\/<name>\/plan\.json`/i,
    ],
    [
      "a missing plan.json says to run npx @monte3l/groundwork . --add-pack <name> first and stops for that pack",
      /`npx @monte3l\/groundwork \. --add-pack <name>` first and stop/i,
    ],
    [
      "gates on plan.schemaVersion and understands schema 1",
      /plan\.schemaVersion[^.]*schema 1/,
    ],
    [
      "a higher schemaVersion stops, changes nothing and tells the user to update the plugin",
      /higher[^.]*stop[^.]*change nothing[^.]*update the plugin/i,
    ],
    [
      "requires plan.kind to be m3l-groundwork/add-pack-plan",
      /`plan\.kind` must be `m3l-groundwork\/add-pack-plan`/,
    ],
    [
      "verifies every staged file's sha256 against plan.staged (shasum -a 256 or node -e)",
      /`shasum -a 256`[^.]*`node -e`[^.]*`plan\.staged`/,
    ],
    [
      "verifies pack.json.staged's own hash too",
      /`pack\.json\.staged`[^.]*`plan\.staged`|`plan\.staged`[^.]*`pack\.json\.staged`/,
    ],
    [
      "checks plan.targetDir resolves to the current project",
      /`plan\.targetDir` resolves to the current project/,
    ],
    [
      "re-checks plan.installation.status against the project (a pack installed meanwhile)",
      /`plan\.installation\.status`[^.]*(still|meanwhile)/i,
    ],
    [
      "uses the bytes read during verification for the install",
      /use the bytes (you )?read (here|in this step)/i,
    ],
    [
      "shows the plan's fields verbatim and without paraphrasing",
      /verbatim and without paraphras/i,
    ],
    [
      "shows plan.fileConflicts as the divergent files",
      /`plan\.fileConflicts`[^.]*divergent/i,
    ],
    ["shows plan.wiringObservations", /`plan\.wiringObservations`/],
    ["shows plan.requires (missing paths)", /`plan\.requires`[^.]*missing/i],
    ["shows the proposed plan.tokens", /proposed `plan\.tokens`/i],
    ["shows any plan.undetermined notes", /`plan\.undetermined`/],
    [
      "asks one AskUserQuestion per pack: install or skip",
      /one `AskUserQuestion` per pack[^.]*install or skip/i,
    ],
    ["also asks the token values to use", /token values/i],
    [
      "asks keep-theirs / take-groundwork's / merge per divergent file",
      /keep[- ]theirs[^.]*take[- ]groundwork's[^.]*merge/i,
    ],
    [
      "treats a dismissed question as skip (nothing installed)",
      /dismissed[^.]*"?skip"?[^.]*nothing installed/i,
    ],
    [
      "writes nothing to a project file before the question is answered",
      /Nothing is written to a project file before this/,
    ],
    [
      "installs each confirmed pack by reading and following pack-install.md in full with the add-pack staging root",
      /\[`pack-install\.md`\]\(pack-install\.md\) in full[^.]*`\.groundwork\/add-pack\/<name>\/`/,
    ],
    [
      "prints the pack's setupSteps and offers to run them",
      /`setupSteps`[^.]*offer/i,
    ],
    ["never runs setupSteps unasked", /never run them unasked/i],
    [
      "runs the project's gate (pnpm verify, or the project's own equivalent for an adopted project)",
      /`pnpm verify`[^.]*(project's own equivalent|its own equivalent)/i,
    ],
    [
      "reports a gate failure honestly rather than hiding it",
      /report[^.]*honestly/i,
    ],
    [
      "writes the ledger entry per pack-install.md's recording step",
      /ledger[^.]*(pack-install\.md|Record the pack)/i,
    ],
    [
      "deletes ONLY .groundwork/add-pack/<name>/ for each installed pack",
      /delete only `\.groundwork\/add-pack\/<name>\/`/i,
    ],
    [
      "also deletes .groundwork/add-pack/ itself when it is now empty",
      /`\.groundwork\/add-pack\/` itself if it is now empty/,
    ],
    ["a skipped pack keeps its staging", /skipped pack keeps its staging/i],
    [
      "never touches another pack's staging",
      /never touch(es)? (another|any other) pack's staging/i,
    ],
    [
      "the final report notes a Claude Code restart may be needed for new hooks",
      /restart[^.]*hooks/i,
    ],
  ])("%s", (_label, pattern) => {
    expect(addPack).toMatch(pattern);
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "the prototype-key check on pack.json.staged wiring names %s and stops, changing nothing",
    (key) => {
      expect(addPack).toContain(`\`${key}\``);
      expect(addPack).toMatch(
        /`__proto__`[^.]*`constructor`[^.]*`prototype`[^.]*stop[^.]*change nothing/i,
      );
    },
  );

  it("treats an over-cap as a WARNING, never a blocker", () => {
    const windows = windowsAround(addPack, "`plan.caps`", 250);
    expect(windows.length).toBeGreaterThan(0);
    expect(
      windows.some((w) => /warning/i.test(w) && /never a blocker/i.test(w)),
    ).toBe(true);
  });

  describe("install-time re-compare, plan.fileConflicts shape and early ledger check", () => {
    const verify = addPack.slice(
      addPack.indexOf("`shasum -a 256`") - 900,
      addPack.indexOf("Show the plan, verbatim"),
    );

    it("step 3 re-compares every target path against the staged bytes/plan at install time (files created or changed since staging)", () => {
      expect(verify).toMatch(/re-(compare|check)[^.]*every target path/i);
      expect(verify).toMatch(
        /(since|after)[^.]*(staged|staging)|(staged|staging)[^.]*(since|after)/i,
      );
    });

    it("a file whose current state differs from the plan is treated as divergent and asked about in the per-file question", () => {
      expect(verify).toMatch(
        /differs from[^.]*`plan\.fileConflicts`[^.]*divergent[^.]*ask/i,
      );
    });

    it("never installs over a changed file without that per-file decision", () => {
      expect(verify).toMatch(
        /(no|never)[^.]*(install|overwr)[^.]*(changed|differs)[^.]*(without|until)[^.]*(decision|answer)/i,
      );
    });

    it("describes plan.fileConflicts as per-file status entries (absent, identical, divergent), shown for the divergent ones", () => {
      const window = windowsAround(addPack, "`plan.fileConflicts`", 400).join(
        " ",
      );
      expect(window).toMatch(/absent/i);
      expect(window).toMatch(/identical/i);
      expect(window).toMatch(/divergent/i);
      expect(window).toMatch(/relPath/);
    });

    it("gets file contents by reading the project file and the staged file, not from the plan", () => {
      expect(addPack).toMatch(
        /read both the project file and the staged file/i,
      );
    });

    it("no longer claims fileConflicts carries 'the project's version and the pack's'", () => {
      expect(addPack).not.toMatch(/each with the project's version/i);
    });

    it("validates the existing ledger BEFORE the per-pack question, stopping with nothing written", () => {
      const ledgerRead = addPack.search(
        /installed-packs\.json`?[^.]*(before|early|first)/i,
      );
      expect(ledgerRead).toBeGreaterThan(-1);
      expect(ledgerRead).toBeLessThan(addPack.indexOf("**Confirm,"));
      expect(addPack).toMatch(
        /installed-packs\.json[^.]*(invalid|higher)[^.]*(prototype|__proto__)[^.]*stop[^.]*(before|nothing)/i,
      );
    });
  });

  it("verifies hashes before showing anything verbatim (ordering of the steps)", () => {
    const hash = addPack.indexOf("`shasum -a 256`");
    const display = addPack.indexOf("verbatim");
    expect(hash).toBeGreaterThan(-1);
    expect(display).toBeGreaterThan(hash);
  });
});

describe("add-pack.md -- what it forbids (negative clauses)", () => {
  it.each([
    "interview",
    "Step 0",
    "Round 2",
    "adoption-decisions.json",
    "customization-report.md",
  ])("every mention of %s sits in a skip/never/no context", (term) => {
    const windows = windowsAround(addPack, term, 160);
    expect(windows.length).toBeGreaterThan(0);
    for (const w of windows) {
      expect(w).toMatch(/\b(skip|skips|never|not|no|without|forbid)/i);
    }
  });

  it("states it skips the interview, Step 0 reconcile, Round 2 and Step 7's report", () => {
    expect(addPack).toMatch(
      /skip[^.]*interview[^.]*Step 0[^.]*Round 2[^.]*Step 7/i,
    );
  });

  it("never writes adoption-decisions.json or customization-report.md", () => {
    expect(addPack).toMatch(
      /never writes?[^.]*`adoption-decisions\.json`[^.]*`customization-report\.md`/i,
    );
  });
});

describe("pack-install.md -- generalised for both paths", () => {
  it("has a 'Where the staged copy lives' preface naming both staging roots", () => {
    expect(packInstall).toContain("Where the staged copy lives");
    const idx = packInstall.indexOf("Where the staged copy lives");
    const preface = packInstall.slice(idx, idx + 900);
    expect(preface).toContain(".groundwork/packs/<name>/");
    expect(preface).toContain(".groundwork/add-pack/<name>/");
    expect(preface).toContain("plan.json");
    expect(preface).toContain("inventory");
    expect(preface).toContain(".staged");
  });

  it("places the preface before the moved procedure's first sentence", () => {
    const preface = packInstall.indexOf("Where the staged copy lives");
    expect(preface).toBeGreaterThan(-1);
    expect(preface).toBeLessThan(
      packInstall.indexOf("Before installing, check the pack's own `modes`"),
    );
  });

  it("has a 'Project shape' note naming a CLI-bootstrapped project's markers", () => {
    expect(packInstall).toContain("Project shape");
    expect(packInstall).toContain("bin/verify.mjs");
    expect(packInstall).toContain("bin/lib/verify-steps.packs.json");
  });

  it.each([
    [
      "hooks merged entry by entry, add-only, into .claude/settings.json",
      /`\.claude\/settings\.json`[^.]*`hooks`[^.]*entry by entry[^.]*add-only/i,
    ],
    [
      "settingsTopLevel only when the key is absent or identical, otherwise ask",
      /`settingsTopLevel`[^.]*only when the key is absent or identical[^.]*ask/i,
    ],
    [
      "package.json scripts are add-only and a different existing script is a collision to ask about",
      /`package\.json`[^.]*`scripts`[^.]*add-only[^.]*collision[^.]*ask/i,
    ],
    [
      "verify-steps.packs.json is appended by id; the same id with different content is a collision",
      /`bin\/lib\/verify-steps\.packs\.json`[^.]*append[^.]*by `id`[^.]*same `?id`? with different content is a collision/i,
    ],
    [
      "any other project keeps the 'translate by hand against the project's real gate' text",
      /other project[^.]*translate[^.]*by hand[^.]*real gate/i,
    ],
  ])("project shape: %s", (_label, pattern) => {
    expect(packInstall).toMatch(pattern);
  });

  it("ends with a FINAL 'Record the pack' step writing .groundwork/installed-packs.json", () => {
    const idx = packInstall.indexOf("Record the pack");
    expect(idx).toBeGreaterThan(-1);
    expect(packInstall.slice(idx)).toContain(
      ".groundwork/installed-packs.json",
    );
    // Final: no other markdown heading follows the record step's own.
    expect(packInstall.slice(idx + 1)).not.toMatch(/(^|\s)#{1,3} (?!Record)/);
  });

  describe("the ledger rules", () => {
    const idx = packInstall.indexOf("Record the pack");
    const ledger = idx === -1 ? "" : packInstall.slice(idx);

    it.each([
      ["reads the existing ledger first", /read the existing ledger first/i],
      [
        "an absent ledger starts as { schemaVersion: 1, packs: [] }",
        /absent[^.]*`\{ "schemaVersion": 1, "packs": \[\] \}`/i,
      ],
      [
        "invalid JSON, an unknown or higher schemaVersion or a prototype-sensitive name => stop, show it, never overwrite",
        /invalid JSON[^.]*schemaVersion[^.]*(prototype|__proto__)[^.]*stop[^.]*show[^.]*never overwrite/i,
      ],
      [
        "adds the entry or REPLACES the entry of the same name (reinstall)",
        /replace[^.]*(entry )?of the same name/i,
      ],
      [
        "keeps the other entries semantically unchanged (the ledger is re-serialised)",
        /other entries[^.]*semantically unchanged/i,
      ],
      [
        "sha256 is null for a file the user kept theirs on",
        /`sha256`[^.]*`null`[^.]*kept (theirs|their)/i,
      ],
      [
        "files[].sha256 is the hash of the installed bytes",
        /sha256[^.]*installed bytes/i,
      ],
      [
        "manifestSha256 is the hash of pack.json.staged",
        /`manifestSha256`[^.]*`pack\.json\.staged`/,
      ],
      [
        "cliVersion comes from plan.cliVersion or inventory.cliVersion",
        /`cliVersion`[^.]*`plan\.cliVersion`[^.]*`inventory\.cliVersion`/,
      ],
      [
        "records wiring applied and skipped (with a reason) and dropped files (with a reason)",
        /`applied`[^.]*`skipped`[^.]*reason[^.]*`dropped`[^.]*reason/i,
      ],
    ])("%s", (_label, pattern) => {
      expect(ledger).toMatch(pattern);
    });

    it("no longer claims the other entries stay byte-for-byte (the ledger is re-serialised)", () => {
      expect(ledger).not.toMatch(/other entries[^.]*byte-for-byte/i);
    });

    it.each(["add-pack", "adopt-round-1", "fresh"])(
      "documents the via value %s",
      (via) => {
        expect(ledger).toContain(`"${via}"`);
      },
    );

    it.each(["installedAt", "files", "wiring"])(
      "names the entry field %s",
      (field) => {
        expect(ledger).toContain(`\`${field}\``);
      },
    );

    it("says only /customize writes the ledger", () => {
      expect(ledger).toMatch(/only[^.]*\/customize[^.]*writes?|written only/i);
    });
  });
});

describe("step-0-reconcile.md -- an add-pack-only .groundwork/ is not an interrupted run", () => {
  const slice01 = step0.slice(
    step0.indexOf("1. Look for `.groundwork/inventory.json`."),
    step0.indexOf("2. **The deep read.**"),
  );

  it("classifies .groundwork/ after ignoring the two entries add-pack/ and installed-packs.json", () => {
    expect(slice01).toMatch(
      /ignor[^.]*`add-pack\/`[^.]*`installed-packs\.json`/i,
    );
  });

  it("no inventory and nothing else => NOT an interrupted run: continue on the fresh path with the git rev-list guard", () => {
    expect(slice01).toMatch(/not an interrupted run[^.]*fresh path/i);
    expect(slice01).toContain("git rev-list -n1 HEAD");
  });

  it("mentions a pending add-pack/*/plan.json: pack(s) staged, run /customize add-pack <name>", () => {
    expect(slice01).toContain("add-pack/*/plan.json");
    expect(slice01).toMatch(/pack\(s\) staged[^"]*\/customize add-pack <name>/);
  });

  it("counts installed-packs.json as a tracked file in the existing clone bullet", () => {
    const start = slice01.indexOf("a clone of an adopted project");
    const end = slice01.indexOf("a previous CLI adopt run did not complete");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(slice01.slice(start, end)).toContain("installed-packs.json");
  });

  it("keeps anything else as the interrupted-run bullet", () => {
    expect(slice01).toContain("a previous CLI adopt run did not complete");
    expect(slice01).toContain("Stop. Never fall through to the fresh flow");
  });

  it("keeps the 'anything else' arm reachable: the interrupted-run bullet is introduced as the remaining case", () => {
    const idx = slice01.indexOf("a previous CLI adopt run did not complete");
    expect(idx).toBeGreaterThan(-1);
    expect(slice01.slice(Math.max(0, idx - 400), idx)).toMatch(
      /anything else|any other|otherwise|but `\.groundwork\/` exists/i,
    );
  });
});

describe("step-0-reconcile.md -- the interrupted-run advice spares the ledger and pending staging", () => {
  const idx = step0.indexOf("a previous CLI adopt run did not complete");
  const bullet = step0.slice(idx, idx + 900);

  it("says to delete everything in .groundwork/ EXCEPT installed-packs.json and add-pack/", () => {
    expect(bullet).toMatch(
      /delete everything in `\.groundwork\/`[^.]*except[^.]*`installed-packs\.json`[^.]*`add-pack\/`/i,
    );
  });

  it("no longer advises deleting the whole .groundwork/", () => {
    expect(bullet).not.toContain("delete `.groundwork/` and run");
  });
});

describe("step-0-reconcile.md -- 0.4(c) honours the installed-packs ledger", () => {
  const confirm = step0.slice(
    step0.indexOf("4. **Confirm.**"),
    step0.indexOf("5. **Record the confirmed decisions**"),
  );
  const packChoice = confirm.slice(confirm.indexOf("(c) **which pack(s)"));

  it("finds the 0.4(c) slice", () => {
    expect(confirm.length).toBeGreaterThan(0);
    expect(packChoice.length).toBeGreaterThan(0);
  });

  it("marks packs listed in a valid .groundwork/installed-packs.json as installed and does not offer them again unless the user asks to reinstall", () => {
    expect(packChoice).toMatch(
      /`\.groundwork\/installed-packs\.json`[^.]*(exists|present)[^.]*valid[^.]*installed[^.]*not offered again[^.]*reinstall/i,
    );
  });

  it("shows an invalid ledger to the user and never overwrites it silently", () => {
    expect(packChoice).toMatch(
      /invalid ledger[^.]*(shown|show)[^.]*never overwritten silently/i,
    );
  });
});

describe("step-3-round-1.md -- the add-pack recipe replaces the adopt re-run recipe", () => {
  it("tells the user to run npx @monte3l/groundwork . --add-pack <name>, then /customize add-pack <name>", () => {
    expect(step3).toMatch(
      /`npx @monte3l\/groundwork \. --add-pack <name>`[^.]*`\/customize add-pack <name>`/,
    );
  });

  it("no longer says to re-run the CLI against a non-empty directory so it auto-detects adopt mode", () => {
    expect(step3).not.toContain(
      "re-run the CLI against this now-non-empty directory",
    );
    expect(step3).not.toContain("it auto-detects adopt mode");
    expect(step3).not.toContain("will offer the pack through the adopt path");
    expect(step3).not.toMatch(/To add a pack after the fact, re-run the CLI/);
  });

  it("keeps the Packs bullet's statement that a fresh bootstrap's packs were installed by the CLI at --pack time", () => {
    expect(step3).toContain("--pack <name>` invocation time");
  });

  it('records the ledger with via: "adopt-round-1" in the adopt Round 1 packs bullet', () => {
    const idx = step3.indexOf("[`pack-install.md`](pack-install.md)");
    expect(idx).toBeGreaterThan(-1);
    const tail = step3.slice(idx, idx + 700);
    expect(tail).toContain("installed-packs.json");
    expect(tail).toContain('via: "adopt-round-1"');
  });
});
