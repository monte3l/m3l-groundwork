import { describe, expect, it } from "vitest";
import { applyTokens } from "../src/tokens.js";

describe("applyTokens", () => {
  it("replaces every occurrence of a known token", () => {
    const result = applyTokens("name: __PROJECT_NAME__ (__PROJECT_NAME__)", {
      PROJECT_NAME: "widgets",
    });
    expect(result).toBe("name: widgets (widgets)");
  });

  it("substitutes multiple distinct tokens independently", () => {
    const result = applyTokens("__A__-__B__", { A: "1", B: "2" });
    expect(result).toBe("1-2");
  });

  it("leaves an unmatched __TOKEN__-shaped literal untouched", () => {
    const result = applyTokens("keep __UNKNOWN__ as-is", { PROJECT_NAME: "x" });
    expect(result).toBe("keep __UNKNOWN__ as-is");
  });

  it("returns the content unchanged when the token table is empty", () => {
    const result = applyTokens("plain text", {});
    expect(result).toBe("plain text");
  });
});
