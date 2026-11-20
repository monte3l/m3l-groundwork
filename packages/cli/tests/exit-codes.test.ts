// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

// The CLI's exit-code table (`.claude/rules/headless-mode.md`) as one constant.
import { describe, expect, expectTypeOf, it } from "vitest";
import { EXIT_CODES, type ExitCode } from "../src/exit-codes.js";

describe("EXIT_CODES", () => {
  it("maps each outcome to its documented code", () => {
    expect(EXIT_CODES).toEqual({
      ok: 0,
      runtime: 1,
      usage: 2,
      pending: 3,
      drift: 4,
    });
  });

  it("types as a readonly literal table, and ExitCode as the union 0 | 1 | 2 | 3 | 4", () => {
    expectTypeOf(EXIT_CODES).toEqualTypeOf<{
      readonly ok: 0;
      readonly runtime: 1;
      readonly usage: 2;
      readonly pending: 3;
      readonly drift: 4;
    }>();
    expectTypeOf<ExitCode>().toEqualTypeOf<0 | 1 | 2 | 3 | 4>();
  });
});
