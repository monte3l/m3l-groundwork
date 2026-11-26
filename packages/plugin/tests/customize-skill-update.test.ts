// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Guards the load-bearing clauses of the `/customize update` entry: the
 * merged sub-command router in `SKILL.md`, the procedure in `update.md` that
 * applies the staged `.groundwork/update/` tree the CLI's `--update` wrote,
 * the "Update an installed pack" section of `pack-install.md`, and the
 * release-please version-marker plumbing. Matching is done against
 * whitespace-collapsed copies so a phrase doesn't break on the markdown's own
 * line wrapping. A missing file reads as "" so only the assertions that need
 * its text fail. Byte identity with `.claude/skills/customize/` is covered by
 * `customize-skill-sync.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const skillDir = join(here, "..", "skills", "customize");

function read(name: string): string {
  const path = join(skillDir, name);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}
function flatten(source: string): string {
  return source.replace(/\s+/g, " ");
}

const skillRaw = read("SKILL.md");
const updateRaw = read("update.md");
const update = flatten(updateRaw);
const packInstall = flatten(read("pack-install.md"));

describe("SKILL.md -- the merged sub-command router", () => {
  const frontmatter = skillRaw.slice(0, skillRaw.indexOf("\n---", 4));
  const heading = "## Sub-commands (add-pack, update)";
  const start = skillRaw.indexOf(heading);
  const step0 = skillRaw.indexOf("## Step 0");
  const section = flatten(skillRaw.slice(start, step0));

  it('declares argument-hint: "[add-pack <name> ... | update]"', () => {
    expect(frontmatter).toContain(
      'argument-hint: "[add-pack <name> ... | update]"',
    );
  });

  it("has the Sub-commands section before Step 0", () => {
    expect(start).toBeGreaterThan(-1);
    expect(step0).toBeGreaterThan(start);
  });

  it("routes update to update.md in full and add-pack to add-pack.md", () => {
    expect(section).toMatch(/\$ARGUMENTS[^.]*starts with[^.]*update/);
    expect(section).toMatch(/read \[`update\.md`\]\(update\.md\) in full/i);
    expect(section).toMatch(/read \[`add-pack\.md`\]\(add-pack\.md\) in full/i);
  });

  it("stays at most 18000 bytes", () => {
    expect(Buffer.byteLength(skillRaw, "utf8")).toBeLessThanOrEqual(18000);
  });
});

describe("update.md -- plan gates", () => {
  it("exists and is headed as the update procedure", () => {
    expect(updateRaw).not.toBe("");
    expect(update).toMatch(/\/customize update/);
  });

  it("understands schemaVersion 1 and stops on a higher one, telling the user to update the plugin", () => {
    expect(update).toMatch(/schemaVersion/);
    expect(update).toMatch(/schemaVersion[^.]*\b1\b/);
    expect(update).toMatch(/higher[^.]*stop[^.]*update[^.]*plugin/i);
  });

  it("checks plan.kind is m3l-groundwork/update-plan", () => {
    expect(update).toContain("m3l-groundwork/update-plan");
    expect(update).toMatch(/kind/);
  });

  it("carries a Skill version marker line for release-please", () => {
    expect(updateRaw).toMatch(
      /^Skill version: \d+\.\d+\.\d+ <!-- x-release-please-version -->$/m,
    );
  });

  it("refuses when the skill's own version is older than plan.cliVersion", () => {
    expect(update).toMatch(/Skill version/);
    expect(update).toContain("cliVersion");
    expect(update).toMatch(/older than[^.]*cliVersion|cliVersion[^.]*newer/i);
    expect(update).toMatch(/refuse|stop/i);
  });
});

describe("update.md -- verification", () => {
  it("hashes every plan.staged file with shasum or node SHA-256", () => {
    expect(update).toMatch(/staged/);
    expect(update).toMatch(/shasum/);
    expect(update).toMatch(/SHA-256/i);
    expect(update).toMatch(/node/i);
  });

  it("stops when no shell is available", () => {
    expect(update).toMatch(/no shell[^.]*stop|stop[^.]*no shell/i);
  });

  it("forbids claiming any check passed when the no-shell stop fires", () => {
    const start = update.search(/no shell/i);
    expect(start).toBeGreaterThanOrEqual(0);
    const paragraph = update.slice(start, start + 900);
    // The stop must forbid stating OR implying that a staged hash, the lock's
    // hash or the working tree's cleanliness was checked or matches.
    expect(paragraph).toMatch(/not (state|claim) or imply/i);
    expect(paragraph).toMatch(/staged file/i);
    expect(paragraph).toMatch(/lock'?s? hash|lock's sha|lock hash/i);
    expect(paragraph).toMatch(/working tree/i);
    expect(paragraph).toMatch(/checked or match/i);
    // Only relaying plan.json is allowed, labelled as the plan's own statement.
    expect(paragraph).toMatch(
      /plan\.json[^.]*(plan's own statement|plan's own claim)|(plan's own statement|plan's own claim)[^.]*plan\.json/i,
    );
  });

  it("forbids describing any file's hashes as matching when the no-shell stop fires", () => {
    const start = update.search(/no shell/i);
    expect(start).toBeGreaterThanOrEqual(0);
    const paragraph = update.slice(start, start + 900).replace(/\s+/g, " ");
    // No file's hashes (customize/ payload, staged files) may be called
    // matching or equal; the skill copy may only relay plan's skill.status.
    expect(paragraph).toMatch(/hashes/i);
    expect(paragraph).toContain("skill.status");
  });

  it("tells the user to re-run /customize update where a shell exists, and that --update only re-stages", () => {
    const start = update.search(/no shell/i);
    expect(start).toBeGreaterThanOrEqual(0);
    const paragraph = update.slice(start, start + 900).replace(/\s+/g, " ");
    expect(paragraph).toContain("/customize update");
    expect(paragraph).toMatch(/re-stages/i);
    expect(paragraph).toMatch(/applies nothing/i);
  });

  it("stops on an extra *.staged file not listed in the plan", () => {
    expect(update).toMatch(
      /extra[^.]*\.staged[^.]*stop|stop[^.]*extra[^.]*\.staged/i,
    );
  });

  it("checks plan.targetDir is the current project", () => {
    expect(update).toContain("targetDir");
    expect(update).toMatch(/targetDir[^.]*(current project|this project)/i);
  });

  it("checks the lock's sha equals plan.base.lockSha256", () => {
    expect(update).toContain("lockSha256");
  });

  it("re-hashes each target and promotes a changed one to review", () => {
    expect(update).toMatch(/re-hash/i);
    expect(update).toMatch(/promot[^.]*review/i);
  });
});

describe("update.md -- presenting and safety", () => {
  it("shows the plan verbatim", () => {
    expect(update).toMatch(/verbatim/i);
  });

  it("requires a git worktree", () => {
    expect(update).toMatch(
      /git worktree|inside a git (work )?tree|git repository/i,
    );
  });

  it("requires `git status --porcelain -z --` over the touched paths to be empty, listing them and stopping otherwise", () => {
    expect(update).toContain("git status --porcelain -z --");
    expect(update).toMatch(/touched/i);
    expect(update).toMatch(/list them[^.]*stop|stop[^.]*list/i);
  });

  it("tolerates unrelated dirty files", () => {
    expect(update).toMatch(
      /unrelated[^.]*(dirty|uncommitted|modified)?[^.]*(fine|ignore|allowed|do not block|don't block)/i,
    );
  });
});

describe("update.md -- decisions", () => {
  it("asks one bulk-defaults question, then one per conflict, review and rename", () => {
    expect(update).toMatch(/bulk/i);
    expect(update).toMatch(/defaults/i);
    expect(update).toMatch(/conflict/i);
    expect(update).toMatch(/review/i);
    expect(update).toMatch(/rename/i);
  });

  it.each(["keep yours", "take groundwork's", "resolve with me", "skip"])(
    "offers the option %s",
    (option) => {
      expect(update.toLowerCase()).toContain(option);
    },
  );

  it("treats a dismissed question as skip", () => {
    expect(update).toMatch(/dismiss[^.]*skip/i);
  });

  it("never writes a file that still contains conflict markers", () => {
    expect(update).toContain("<<<<<<<");
    expect(update).toMatch(/never write[^.]*conflict marker/i);
  });
});

describe("update.md -- applying", () => {
  it("creates groundwork/update-<base>-to-<cli> with git switch -c before applying", () => {
    expect(update).toContain("groundwork/update-<base>-to-<cli>");
    expect(update).toContain("git switch -c");
    expect(update).toMatch(/before[^.]*apply|apply[^.]*after/i);
  });

  it("words the rename option as kept yours consistently, never kept theirs", () => {
    expect(update).not.toMatch(/unless the user kept theirs/i);
    expect(update).toMatch(/rename[^.]*unless the user kept yours/i);
  });

  it("applies packs through pack-install.md", () => {
    expect(update).toContain("pack-install.md");
  });

  it("removes dropped wiring only when the plan marks it removable and the user confirmed", () => {
    expect(update).toMatch(/dropped wiring|removed wiring|removals?/i);
    expect(update).toContain("plan.packs[].wiring.removed[].removable");
    expect(update).toContain("changed[].applies");
    expect(update).toMatch(/\breason\b/);
    expect(update).not.toMatch(/old fragment/i);
    expect(update).toMatch(/confirm/i);
  });

  it("shows the removable and applies flags with their reason in step 4", () => {
    const step4 = update.slice(
      update.indexOf("4. **Show the plan"),
      update.indexOf("5. **Check it is safe"),
    );
    expect(step4).toContain("removable");
    expect(step4).toContain("applies");
    expect(step4).toContain("reason");
  });

  it("lists the customize payload files and renamedTo targets as touched paths in step 5", () => {
    const step5 = update.slice(
      update.indexOf("5. **Check it is safe"),
      update.indexOf("6. **Confirm"),
    );
    expect(step5).toContain(".claude/skills/customize/");
    expect(step5).toMatch(/payload/i);
    expect(step5).toContain("renamedTo");
  });

  it("stages the full touched set in step 11, not a subset", () => {
    const step11 = update.slice(update.indexOf("11. **Report"));
    expect(step11).toContain("git add -- <touched>");
    expect(step11).toMatch(/payload/i);
    expect(step11).toMatch(/renamedTo|both ends of a rename/i);
  });

  it("re-hash also requires a rename's renamedTo to be absent, else review", () => {
    const step3 = update.slice(
      update.indexOf("3. **Verify before"),
      update.indexOf("4. **Show the plan"),
    );
    expect(step3).toMatch(/renamedTo[^.]*absent/i);
    expect(step3).toMatch(/renamedTo[^.]*review|review[^.]*renamedTo/i);
  });

  it("refreshes .claude/skills/customize/ LAST, touching payload names only", () => {
    expect(update).toContain(".claude/skills/customize/");
    expect(update).toMatch(/last/i);
    expect(update).toMatch(/payload names/i);
  });

  it("offers setupSteps", () => {
    expect(update).toContain("setupSteps");
  });

  it("runs the project gate and reports its result honestly", () => {
    expect(update).toMatch(/gate/i);
    expect(update).toMatch(/honest/i);
  });
});

describe("update.md -- recording", () => {
  it("rewrites the lock from lock-next.json patched with the user's choices", () => {
    expect(update).toContain("lock-next.json");
    expect(update).toMatch(/patch/i);
  });

  it("moves files/*.staged into .groundwork/base/*.base", () => {
    expect(update).toContain(".groundwork/base/");
    expect(update).toMatch(/\.base/);
  });

  it("removes the base of deleted paths", () => {
    expect(update).toMatch(/delet[^.]*base|base[^.]*delet/i);
  });

  const step10 = update.slice(
    update.indexOf("10. **Record"),
    update.indexOf("11. **Report"),
  );

  it("lock patch handles a rename: drops the old path and records renamedTo with the sha256 of staged.theirs", () => {
    expect(step10).toMatch(/rename[^.]*drop[^.]*old path|drop[^.]*old path/i);
    expect(step10).toContain("renamedTo");
    expect(step10).toMatch(
      /sha256[^.]*staged\.theirs|staged\.theirs[^.]*sha256/i,
    );
    expect(step10).toContain("staged.files");
  });

  it("removes the renamedTo record when an apply-default rename is skipped", () => {
    expect(step10).toMatch(
      /skipped[^.]*rename[^.]*renamedTo|rename[^.]*skipped[^.]*(remove|drop)[^.]*renamedTo/i,
    );
  });

  it("keep yours on a rename names the path recorded", () => {
    expect(step10).toMatch(/keep yours[^.]*rename[^.]*(path|record)/i);
  });

  it("treats a review entry with null theirsSha256 as a delete and drops the lock entry instead of writing a null baseSha256", () => {
    expect(step10).toMatch(/theirsSha256[^.]*null|null[^.]*theirsSha256/i);
    expect(step10).toMatch(/drop[^.]*lock entry|lock entry[^.]*dropped/i);
    expect(step10).toMatch(
      /never[^.]*baseSha256[^.]*null|not[^.]*baseSha256[^.]*null/i,
    );
  });

  it("copies the base from files/*.staged for every entry whose theirs is staged, and from the unchanged project file for current entries", () => {
    expect(step10).toMatch(/every entry whose theirs is staged/i);
    expect(step10).toMatch(
      /current[^.]*unchanged project file|unchanged project file[^.]*current/i,
    );
  });

  it("deletes the base only for deleted paths and rename old paths", () => {
    expect(step10).toMatch(
      /only[^.]*deleted path[^.]*old path|only for[^.]*deleted/i,
    );
    expect(step10).not.toMatch(/any path whose new base is not staged/i);
  });

  it('writes ledger entries with via: "update"', () => {
    expect(update).toContain('via: "update"');
  });

  it("deletes .groundwork/update/", () => {
    expect(update).toMatch(/delet[^.]*\.groundwork\/update\//i);
  });

  it("offers but never makes a commit chore(groundwork): update baseline <a> -> <b>", () => {
    expect(update).toContain("chore(groundwork): update baseline <a> -> <b>");
    expect(update).toMatch(/offer/i);
    expect(update).toMatch(
      /never (make|run|create)[^.]*commit|does not commit|do not commit/i,
    );
  });

  it("stages with git add -- <touched> only", () => {
    expect(update).toContain("git add -- <touched>");
  });

  it("never pushes", () => {
    expect(update).toMatch(/never push/i);
  });

  it("never writes adoption-decisions.json or customization-report.md, and runs no interview", () => {
    expect(update).toMatch(/never write[^.]*adoption-decisions\.json/i);
    expect(update).toContain("customization-report.md");
    expect(update).toMatch(
      /no interview|never run the interview|skip[^.]*interview/i,
    );
  });
});

describe("pack-install.md -- Update an installed pack", () => {
  const start = packInstall.indexOf("Update an installed pack");

  it("has the section", () => {
    expect(start).toBeGreaterThan(-1);
  });

  const section = start === -1 ? "" : packInstall.slice(start);

  it('says the ledger entry gets via: "update"', () => {
    expect(section).toContain('via: "update"');
  });

  it("removes dropped wiring only when the plan marks the item removable, using the plan's fields instead of an old-fragment comparison", () => {
    expect(section).toContain("removable");
    expect(section).toContain("applies");
    expect(section).not.toMatch(/old fragment/i);
  });
});

describe("release-please version-marker plumbing", () => {
  const config = JSON.parse(
    readFileSync(join(repoRoot, "release-please-config.json"), "utf8"),
  ) as {
    packages: Record<
      string,
      { "extra-files"?: { type: string; path: string }[] }
    >;
  };
  const extraFiles = Object.values(config.packages).flatMap(
    (p) => p["extra-files"] ?? [],
  );

  it.each([
    "packages/plugin/skills/customize/update.md",
    ".claude/skills/customize/update.md",
  ])("lists %s as a generic extra-file", (path) => {
    expect(extraFiles).toContainEqual({ type: "generic", path });
  });
});
