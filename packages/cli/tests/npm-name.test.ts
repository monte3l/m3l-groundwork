// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { isSafeProjectName } from "../src/npm-name.js";

describe("isSafeProjectName", () => {
  it.each([
    "widgets",
    "my-app",
    "MyApp",
    "My App",
    "@scope/pkg",
    "a.b_c-d",
    "my+app~1",
    "café",
    "日本語",
    "a",
    "a".repeat(214),
  ])("accepts %j", (name) => {
    expect(isSafeProjectName(name)).toBe(true);
  });

  it.each([
    "",
    "-a",
    "--yes",
    "a'b",
    'a"b',
    "a`b`",
    "a$b",
    "$(id)",
    "a;b",
    "a&b",
    "a|b",
    "a<b",
    "a>b",
    "a(b)",
    "a\\b",
    "a\nb",
    "a\tb",
    "a\0b",
    "a\u001bb",
    "a\u007fb",
    "a".repeat(215),
  ])("refuses %j", (name) => {
    expect(isSafeProjectName(name)).toBe(false);
  });

  it("allows a dash anywhere but first", () => {
    expect(isSafeProjectName("a-")).toBe(true);
    expect(isSafeProjectName("-")).toBe(false);
  });
});
