// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Allowlist contract for `guard-readonly-bash.mjs`: Rule 3 (argument guards on
 * the guarded readers `sed`, `find`, `sort` and `uniq`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadGuard, type LoadedGuard } from "./guard-readonly-bash-loader.js";

let guard: LoadedGuard;

beforeAll(async () => {
  guard = await loadGuard();
});

afterAll(() => {
  guard.cleanup();
});

describe("Rule 3 -- sed", () => {
  it.each([
    "sed -i s/a/b/ f",
    "sed -ni s/a/b/p f",
    "sed -ibak s/a/b/ f",
    "sed -i.bak s/a/b/ f",
    "sed -Ei s/a/b/ f",
    "sed --in-place s/a/b/ f",
    "sed --in-place=.bak s/a/b/ f",
    "sed --in-pl s/a/b/ f",
    "sed --i s/a/b/ f",
    'sed -n "w out.txt" f',
    "sed -n 'w out.txt' f",
    "sed 'W out.txt' f",
    "sed -n '/x/w out.txt' f",
    "sed 's/a/b/w out.txt' f",
    "sed 'e' f",
    "sed 's/a/b/e' f",
    "sed -e 'w out.txt' f",
    "sed -n -e 'w out.txt' f",
    "sed --expression='w out.txt' f",
  ])("blocks %s", (command) => {
    expect(guard.classify(command).blocked).toBe(true);
  });

  it.each([
    "sed -n '1,20p' f",
    "sed -n 's/a/b/p' f",
    "sed 's/w/x/' f",
    "sed -E 's/(a|b)+/x/g' f",
    "sed -n '/error/p' f",
    "sed -n '$p' f",
    "sed -e 's/a/b/' f",
    "sed --expression='s/a/b/' f",
    "sed -s -n 1p f g",
  ])("allows %s", (command) => {
    expect(guard.classify(command).blocked).toBe(false);
  });
});

describe("Rule 3 -- find", () => {
  it.each([
    "find . -delete",
    "find . -fprint out.txt",
    "find . -fprint0 out.txt",
    "find . -fprintf out.txt '%p'",
    "find . -fls out.txt",
    "find . -exec rm {} \\;",
    "find . -execdir rm {} \\;",
    "find . -ok rm {} \\;",
    "find . -okdir rm {} \\;",
    "find . -exec sh -c 'rm x' \\;",
    "find . -exec rm {} +",
    "find . -exec cat {}",
    "find . -exec \\;",
  ])("blocks %s", (command) => {
    expect(guard.classify(command).blocked).toBe(true);
  });

  it.each([
    "find . -name '*.ts'",
    "find . -type f -newer x",
    "find . -exec cat {} \\;",
    "find . -exec grep -l foo {} +",
    "find . -execdir cat {} \\;",
    "find . -name x -print",
  ])("allows %s", (command) => {
    expect(guard.classify(command).blocked).toBe(false);
  });
});

describe("Rule 3 -- sort", () => {
  it.each([
    "sort -o out f",
    "sort -ro out f",
    "sort --output out f",
    "sort --output=out f",
    "sort --out=out f",
    "sort -uo out f",
  ])("blocks %s", (command) => {
    expect(guard.classify(command).blocked).toBe(true);
  });

  it.each([
    "sort f",
    "sort -r f",
    "sort -u f",
    "sort -k2 f",
    "sort -t, -k2 f",
    "sort -n f g",
  ])("allows %s", (command) => {
    expect(guard.classify(command).blocked).toBe(false);
  });
});

describe("Rule 3 -- uniq", () => {
  it.each(["uniq in out", "uniq -c in out"])("blocks %s", (command) => {
    expect(guard.classify(command).blocked).toBe(true);
  });

  it.each(["uniq", "uniq f", "uniq -c f", "uniq -f 1 f", "uniq -s 2 -w 3 f"])(
    "allows %s",
    (command) => {
      expect(guard.classify(command).blocked).toBe(false);
    },
  );
});

describe("Rule 3 -- chained and piped use", () => {
  it("allows a read-only pipeline through sort and uniq", () => {
    expect(guard.classify("git log --oneline | sort | uniq -c").blocked).toBe(
      false,
    );
  });

  it("blocks sort -o at the end of a pipeline", () => {
    expect(guard.classify("git log | sort -o x").blocked).toBe(true);
  });

  it("blocks sed -i behind an xargs prefix", () => {
    expect(guard.classify("find . -name x | xargs sed -i s/a/b/").blocked).toBe(
      true,
    );
  });
});

describe("sed script files and find -exec terminators", () => {
  it.each([
    "sed -f script.sed f",
    "sed --file script.sed f",
    "sed --file=script.sed f",
    "sed --fi script.sed f",
  ])("blocks %s because the script file cannot be inspected", (command) => {
    const verdict = guard.classify(command);
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toContain("script file");
  });

  it.each(["sed -ne p f", "sed -n -e p f"])("allows %s", (command) => {
    expect(guard.classify(command).blocked).toBe(false);
  });

  it.each(["sort --compress-program=x f", "sort --co=x f"])(
    "blocks %s",
    (command) => {
      expect(guard.classify(command).blocked).toBe(true);
    },
  );

  it("allows find . -exec cat {} + (the + terminator)", () => {
    expect(guard.classify("find . -exec cat {} +").blocked).toBe(false);
  });

  it("blocks find . -exec cat {} with no terminator", () => {
    expect(guard.classify("find . -exec cat {}").blocked).toBe(true);
  });
});
