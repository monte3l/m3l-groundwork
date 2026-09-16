import { describe, expect, it } from "vitest";
import { placeholder } from "../src/index.js";

describe("placeholder", () => {
  it("returns a non-empty greeting", () => {
    expect(placeholder()).toContain("hello");
  });
});
