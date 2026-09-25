# Security review record

> **In plain terms:** this is the dated record OpenSSF Best Practices' Gold-level
> `security_review` criterion asks for -- proof that someone actually sat down and
> checked the project's security posture against its own stated design, not just
> that a design exists. [`docs/assurance-case.md`](assurance-case.md) is the
> _argument_ (what could go wrong, what stops it); this file is the _record_ that
> the argument was checked against the real repository on a specific date.

## Scope

Same scope as [`docs/assurance-case.md`](assurance-case.md): `packages/cli`,
`packages/plugin`, and the `templates/` payload as they ship from this
repository. The security boundary reviewed is the one that document's trust-
boundary table describes -- CLI `argv` into the process, an adopted project's
files into the survey/grader code, fresh mode's emitted project into
`pnpm install`, and the CI `pack`/`publish` job boundary.

## 2026-09 review

**Method.** A manual design review against
[`docs/assurance-case.md`](assurance-case.md)'s threat model and trust-boundary
table, cross-checked against three independent automated signals covering
different failure classes:

- **GitHub CodeQL** (default setup, every push and PR) -- common vulnerability
  patterns (injection, unsafe deserialization, path handling) in the CLI's own
  TypeScript.
- **OpenSSF Scorecard** (`scorecard.yml`, weekly) -- supply-chain and repository
  hygiene (pinned dependencies, branch protection, token permissions).
- **Property-based dynamic analysis** (fast-check, `pnpm test`, every push, PR,
  and pre-release `pack` job) -- see "Dynamic analysis" below. This is new since
  the Silver-level assurance case was written; the review below reflects it.

**Findings and disposition.**

| Area                                                | Finding                                                                                                                                                                                                                                                                                                                                                                                                          | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CWE-22 (path traversal) surfaces                    | `emitTemplate`'s per-file target path is derived from `templates/core`'s own tree plus token substitution, never from unvalidated external input directly.                                                                                                                                                                                                                                                       | Confirmed safe: the only externally influenced input reaching a path join (`--pack`, `--name`) is allowlist-validated in `parseArgs` before any filesystem access (see `docs/assurance-case.md`'s CWE-22 row). Added an explicit `node:assert` invariant at the `emitTemplate` boundary asserting every resolved target path stays inside `targetDir`, so a future regression fails loudly in CI rather than silently escaping.                                                                                                                                                          |
| Adopt mode's write scope                            | `.groundwork/inventory.json`, `.groundwork/adoption-report.md`, and a guarded `/customize` copy are the only writes adopt mode makes.                                                                                                                                                                                                                                                                            | Confirmed by `adopt.e2e.test.ts` and additionally checked by a runtime assertion (`assertAdoptWriteScope` in `main.ts`) at every adopt-mode write call site. This **detects** an escape immediately after it happens (three of the four call sites assert once the write has already occurred), rather than **preventing** one the way `emit.ts`'s check does (asserted before the write) -- acceptable here because none of the asserted paths are derived from adversarial input (see `docs/assurance-case.md`'s trust-boundary table), but recorded precisely rather than overstated. |
| JSONC string-boundary handling                      | The fuzzer found a real defect: `stripJsoncNoise`'s trailing-comma cleanup ran as a blind regex outside the function's own string-tracking scan, so a JSON key or value literally containing `,}`/`,]` could be corrupted.                                                                                                                                                                                       | **Fixed**: the trailing-comma removal now happens inside the same character scan that tracks string boundaries. `jsonc.property.test.ts`'s round-trip property now holds unconditionally (no exclusion filter).                                                                                                                                                                                                                                                                                                                                                                          |
| `mergePackageScripts` inherited-property read       | The fuzzer found a real defect: `scripts[name]` read via bracket access resolved an inherited `Object.prototype` member (`toString`, `constructor`, ...) for a script name that was never actually set on `existing`, reporting a false collision.                                                                                                                                                               | **Fixed**: presence is now checked with `Object.hasOwn` before the value is read, per `.claude/rules/src.md`'s own convention.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Prototype-pollution-shaped write in `merge-json.ts` | While fixing the finding above, `code-implementer` flagged a related, narrower issue: `mergePackageScripts`/`mergeSettingsTopLevel`/`mergeSettingsHooks` all write via `record[key] = value` with no rejection of `key === "__proto__"`. For `mergeSettingsTopLevel` specifically, a fragment naming `__proto__` with an object value would repoint `settings`'s prototype rather than merely dropping a script. | **Accepted as a tracked residual risk, not fixed in this review**: today's only caller is a pack's own `pack.json`/`wiring` fragment, already inside this project's trusted-content boundary (see `docs/assurance-case.md`'s trust-boundary table -- a pack is reviewed repository content, not untrusted external input). Tracked as [#48](https://github.com/monte3l/m3l-groundwork/issues/48) rather than rushed into this change.                                                                                                                                                    |
| Token substitution completeness                     | A `__KEY__`-shaped token with no matching key is left untouched by design (`tokens.ts`'s own header comment). The fuzzer additionally found that a _known_ key's placeholder can reappear after substitution when one key's replacement value happens to contain another key's `__KEY__` marker -- a real limitation of a single split/join pass over a fixed table, not a defect introduced by this review.     | Confirmed not a security issue: `applyTokens` only ever substitutes `templates/core`'s own literal content, never attacker-controlled input, so a residual placeholder is at worst a template-authoring bug `bootstrap.e2e.test.ts`'s real install would catch, never an injection vector. No runtime assertion was added for this (a correct one would need to describe a different, weaker invariant than "no known key remains" -- see `tokens.property.test.ts`'s own comment); left as a documented limitation.                                                                     |
| Build reproducibility                               | Two clean `pnpm build && pnpm pack` runs were compared byte-for-byte.                                                                                                                                                                                                                                                                                                                                            | Verified reproducible; see `pack.e2e.test.ts`'s reproducible-build case and `SECURITY.md`'s "Reproducing a release".                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Scorecard's `Fuzzing` check                         | Still reports absent -- it looks specifically for OSS-Fuzz/ClusterFuzzLite integration or a recognized fuzzing harness, neither of which fits a CLI with no long-running network-facing service.                                                                                                                                                                                                                 | Accepted as a known Scorecard heuristic gap, not a live risk -- see `SECURITY.md`'s "Accepted OpenSSF Scorecard findings". The dynamic-analysis gap it was standing in for is now independently closed by the property-based suite below, which Scorecard's specific check doesn't recognize.                                                                                                                                                                                                                                                                                            |

No finding required a fix beyond the hardening already described above (the new
assertion and the reproducibility test case, both landed alongside this review).

## Dynamic analysis

`fast-check` property tests (files named `*.property.test.ts`) run inside
`pnpm test`, so on every push, every PR, and in `release.yml`'s `pack` job
before any release -- "before its release," per the Gold criterion's wording,
not a one-off manual run. They exercise the CLI's own parsers and boundary
logic (`jsonc.ts`, `tokens.ts`, `assets.ts`'s dotfile mapping, `merge-json.ts`)
against generated input across their full domain, and differentially fuzz
the harness grader's `frontmatter.ts` TypeScript implementation against its
emitted JavaScript twin (see `CLAUDE.md`'s "The harness grader has two
implementations that must not drift"). The toolchain grader's property tests
check a narrower property -- that every rule never throws and degrades to
`{checked:0}` rather than guessing on unparseable input -- not a twin diff;
extending it to a full differential fuzz against
`templates/core/bin/lib/toolchain-rules.mjs` (see CLAUDE.md's "The toolchain
grader has the same two-implementations shape") is real follow-up work, not
yet done. `node:assert/strict` invariants at the trust boundaries named in
the table above run live wherever the guarded code path executes -- in these
property tests, in `pnpm test`'s example-based suite (`emit.test.ts` already
exercises `emitTemplate` directly), and in the e2e suite -- so a violation
fails the run rather than passing silently.

## Next review

Due within 5 years of this review, or at GA (leaving the `rc` prerelease
series -- see [`ROADMAP.md`](../ROADMAP.md)), whichever comes first.

---

_Performed and signed off by: **[maintainer to complete: name, date, and a one-line confirmation that the manual review above was actually carried out, not only drafted]**._
