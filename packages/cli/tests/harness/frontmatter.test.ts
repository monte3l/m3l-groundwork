import { describe, expect, it } from "vitest";
import {
  fieldList,
  fieldText,
  parseFrontmatter,
} from "../../src/harness/frontmatter.js";

function fieldsOf(content: string): Map<string, string | string[]> {
  const result = parseFrontmatter(content);
  if (!result.ok) throw new Error(result.error);
  return result.fields;
}

describe("parseFrontmatter", () => {
  it("reads a plain scalar", () => {
    expect(fieldsOf("---\nname: starting-work\n---\nbody").get("name")).toBe(
      "starting-work",
    );
  });

  it("reads a folded `>-` block scalar as one line -- the shape every baseline SKILL.md uses", () => {
    const fields = fieldsOf(
      "---\nname: a\ndescription: >-\n  The pre-work decision gate: inspects\n  git state, recommends a branch.\n---\n",
    );
    expect(fields.get("description")).toBe(
      "The pre-work decision gate: inspects git state, recommends a branch.",
    );
  });

  it("keeps a blank line inside a folded scalar as a newline", () => {
    const fields = fieldsOf("---\nd: >\n  one\n  two\n\n  three\n---\n");
    expect(fields.get("d")).toBe("one two\nthree");
  });

  it("reads a literal `|` block scalar preserving line breaks", () => {
    const fields = fieldsOf("---\nd: |-\n  one\n  two\n---\n");
    expect(fields.get("d")).toBe("one\ntwo");
  });

  it("reads double- and single-quoted scalars", () => {
    const fields = fieldsOf(
      `---\na: "say \\"hi\\""\nb: 'it''s'\nc: "x # not a comment"\n---\n`,
    );
    expect(fields.get("a")).toBe('say "hi"');
    expect(fields.get("b")).toBe("it's");
    expect(fields.get("c")).toBe("x # not a comment");
  });

  it("strips a trailing YAML comment from a plain scalar", () => {
    expect(fieldsOf("---\nmodel: sonnet # pinned\n---\n").get("model")).toBe(
      "sonnet",
    );
  });

  it("reads block lists, both indented and flush", () => {
    const fields = fieldsOf(
      '---\npaths:\n  - "src/**"\n  - tests/**\nother:\n- a\n- b\n---\n',
    );
    expect(fields.get("paths")).toEqual(["src/**", "tests/**"]);
    expect(fields.get("other")).toEqual(["a", "b"]);
  });

  it("reads flow lists, including quoted items containing commas", () => {
    const fields = fieldsOf('---\nmcpServers: [context7, "a,b"]\n---\n');
    expect(fields.get("mcpServers")).toEqual(["context7", "a,b"]);
  });

  it("joins a multi-line plain scalar with spaces", () => {
    const fields = fieldsOf(
      "---\ndescription: first\n  second\nname: x\n---\n",
    );
    expect(fields.get("description")).toBe("first second");
    expect(fields.get("name")).toBe("x");
  });

  it("records a nested mapping as an empty value instead of misparsing it", () => {
    const fields = fieldsOf(
      "---\nmcpServers:\n  context7:\n    command: npx\nname: x\n---\n",
    );
    expect(fields.get("mcpServers")).toBe("");
    expect(fields.get("name")).toBe("x");
  });

  it("returns the body after the closing fence", () => {
    const result = parseFrontmatter("---\nname: x\n---\n# Title\nline\n");
    expect(result.ok && result.body).toBe("# Title\nline\n");
  });

  it("tolerates CRLF line endings", () => {
    expect(fieldsOf("---\r\nname: x\r\n---\r\n").get("name")).toBe("x");
  });

  it("fails cleanly with no frontmatter, or an unclosed block", () => {
    expect(parseFrontmatter("# just markdown")).toMatchObject({ ok: false });
    expect(parseFrontmatter("---\nname: x\n")).toMatchObject({ ok: false });
  });

  it("reports lines it cannot interpret and duplicate keys instead of dropping them", () => {
    const result = parseFrontmatter("---\n???\nname: a\nname: b\n---\n");
    expect(result.ok && result.problems).toEqual([
      "unparseable frontmatter line: ???",
      "duplicate frontmatter key: name",
    ]);
  });

  it("reports an unterminated quote and an unterminated flow list", () => {
    const result = parseFrontmatter('---\na: "open\nb: [x, y\n---\n');
    expect(result.ok && result.problems).toEqual([
      "unterminated quoted string for key: a",
      "unterminated flow list for key: b",
    ]);
  });
});

describe("fieldText / fieldList", () => {
  const fields = fieldsOf(
    "---\nname: x\npaths:\n  - a\n  - b\nempty:\nsingle: src/**\n---\n",
  );

  it("fieldText joins a list and returns undefined for an absent key", () => {
    expect(fieldText(fields, "paths")).toBe("a, b");
    expect(fieldText(fields, "name")).toBe("x");
    expect(fieldText(fields, "missing")).toBeUndefined();
  });

  it("fieldList wraps a scalar, keeps a list, and maps an empty value to []", () => {
    expect(fieldList(fields, "single")).toEqual(["src/**"]);
    expect(fieldList(fields, "paths")).toEqual(["a", "b"]);
    expect(fieldList(fields, "empty")).toEqual([]);
    expect(fieldList(fields, "missing")).toBeUndefined();
  });
});
