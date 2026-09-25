# Security assurance case

This is m3l-groundwork's security assurance case, as required by the
OpenSSF Best Practices badge's Silver-level `assurance_case` criterion. It
follows the structure the badge project itself points to (NIST IR 7608's
definition, and the badge project's own assurance case as a worked
example): a threat model, the trust boundaries it implies, an argument that
secure-design principles were applied, and an argument that common
implementation weaknesses were countered.

This document is about the tool (`packages/cli`, `packages/plugin`, and
their `templates/` payload) as it ships from this repository. It does not
cover the security of a project this tool bootstraps or adopts -- that
project's own choices are its owner's responsibility, as `SECURITY.md`
states.

## Threat model

**Assets:**

- The user's target directory -- the thing fresh mode writes into and
  adopt mode reads.
- The published npm tarball (`@monte3l/groundwork`) and its supply chain --
  the lockfile, the GitHub Actions that build and publish it, the npm
  trusted-publishing OIDC exchange.
- Repository secrets and access: `APP_CLIENT_ID`/`APP_PRIVATE_KEY` (the
  version-PR GitHub App), `CLAUDE_CODE_OAUTH_TOKEN`, the `main` branch
  ruleset, and the `npm-publish` environment's approval gate.
- The maintainer's development machine and GPG signing key.

**Actors and threats considered:**

- A malicious or careless contributor to a `templates/packs/` pack or
  `templates/core/` itself, whose payload later runs on every future
  bootstrapped project.
- A compromised upstream dependency or GitHub Action used while building,
  testing, or releasing this repo.
- An adopted project's own files, treated as untrusted input to the survey
  and grading code (a project's `eslint.config.js`, `vitest.config.ts`, or
  `lefthook.yml` could contain anything).
- A hostile or malformed CLI invocation (`argv`), since the CLI runs
  unsandboxed on the invoking machine.
- Someone attempting to install a tampered release (a supply-chain
  substitution attack against the npm package itself).

**Explicitly out of scope:** vulnerabilities in a bootstrapped project's own
chosen dependencies (see `SECURITY.md`, "What this is not"), and attacks
that require the CLI's own dependency tree to be compromised via a runtime
dependency -- there isn't one (`packages/cli/package.json`'s
`dependencies` is `{}`).

## Trust boundaries

| Boundary                                                  | Trusted side                                | Untrusted / lower-trust side                                                                 | Enforcement                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI `argv` → the process                                  | The CLI's own parsing logic                 | Anything the invoker typed                                                                   | `main.ts`'s `parseArgs`/`tokenizeArgv` validate shape before any filesystem access; unknown flags and malformed values throw `CliUsageError` (exit 2), never silently proceed.                                                                                                                  |
| `templates/` and the plugin payload → the emitted project | This repository's own tree, reviewed via PR | N/A -- this side is always trusted; it ships from this repo                                  | `assets.ts`'s `resolveAsset` locates it by a positive marker (a `pnpm-workspace.yaml` plus this repo's own `package.json` name three directories up), never by an unscoped walk that could resolve into a different, attacker-controlled tree.                                                  |
| An adopted project's files → the survey/grader code       | This repo's collector and grader code       | The target project's own `eslint.config.js`, `vitest.config.ts`, `lefthook.yml`, source tree | Every collector reads facts only, never infers or executes; project code is **never run** -- config files are scraped by regex over comment-stripped text, not `require`d or evaluated. A scrape that can't tell the answer returns `{ checked: 0 }` rather than guessing.                      |
| Fresh mode's own emitted project → `pnpm install`         | This repo's `git.ts`                        | The npm registry and whatever the new project's `package.json` names                         | `execFileSync` with an argv array, never a shell string -- no command injection surface from a project name or path. This is the CLI's only network egress.                                                                                                                                     |
| CI `pack`/`publish` jobs → npm / GitHub                   | `release.yml`'s job boundaries              | The OIDC token, the npm registry                                                             | `pack` (builds, tests, packs) holds no publish credential; only `publish` holds `id-token: write`, runs no repository code beyond the changesets CLI and a thin `pnpm`→`npm stage publish` shim, and installs with `--ignore-scripts`. See `CLAUDE.md`'s "Releases".                            |
| `claude.yml`/`claude-pr-review.yml` → the repository      | The workflow's own job                      | A PR's contents (for the review workflow), an `@claude` mention body                         | The review workflow holds `contents: read` only and cannot push, approve, or satisfy a required check; the mention workflow never opens a PR itself, only a branch plus a PR-creation link. Both exclude bot- and fork-authored PRs from `if:` before they'd otherwise fail on missing secrets. |

## Secure design principles applied (Saltzer & Schroeder)

- **Least privilege.** Every GitHub Actions workflow resets permissions to
  `{}` or `contents: read` at the top level and grants only what each job
  needs (`release.yml`'s `publish` job is the only one holding
  `id-token: write`; see `CLAUDE.md`'s "Continuous integration"). One
  documented exception: `scorecard.yml` holds `read-all`, which
  OpenSSF Scorecard's own action requires to inspect the repository's
  branch-protection and permission settings -- read-only, and not a write
  privilege this principle is about.
- **Fail-safe defaults.** Adopt mode's default action is to write nothing
  but `.groundwork/` and a guarded, additive `/customize` copy; a fresh-mode
  collision with an existing directory is a hard error unless `--force` is
  passed explicitly, never a silent overwrite.
- **Economy of mechanism.** Zero runtime dependencies in `packages/cli`;
  token substitution is a plain string replace, not a template engine or
  interpreter; process execution is `execFileSync` with argv arrays, never
  a shell.
- **Complete mediation.** The `main` branch ruleset has an empty
  `bypass_actors` list -- every change, including the maintainer's own,
  passes through the same required checks. There is no standing bypass
  path for source or test writes on `main` either: `guard-hub-src-writes.mjs`
  and `guard-branch-isolation.mjs` enforce the hub-and-spoke model
  unconditionally.
- **Separation of privilege.** Publishing a release needs two independent
  approvals from the same person acting in two different capacities: the
  `npm-publish` GitHub environment's required-reviewer gate (before the git
  tag or GitHub Release exist), and npm's own 2FA-gated `npm stage approve`
  (before the staged version becomes installable). Neither step is
  automatable, by design on both sides.
- **Open design.** The whole toolchain, its CI, and this assurance case are
  public; no security property here depends on any part of the design
  staying secret.
- **Least common mechanism.** Fresh mode and adopt mode don't share a
  generic "write into the target directory" facility. Adopt mode's only
  writes are `.groundwork/inventory.json`, `.groundwork/adoption-report.md`,
  and a guarded, additive `/customize` copy -- there is no code path by
  which surveying an arbitrary, untrusted project can reach the same
  unrestricted file-writing fresh mode uses, so a defect in one mode's
  write logic can't leak into the other's trust domain.
- **Psychological acceptability.** The CLI makes no prompts and no
  interactive choices in Phase A -- "no prompts, no interactivity" is
  stated in `main.ts`'s own header -- so its behavior is predictable and
  scriptable; the one adaptive, judgment-requiring phase (`/customize`) is
  kept separate and always shows its reasoning (survey evidence, guidance
  sources) before acting.

## Common implementation weaknesses countered (CWE Top 25 -- relevant subset)

| CWE                                                        | Relevance                                                    | Mitigation                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CWE-22 (Path Traversal)                                    | `--pack <name>` reaches `join(root, name)` in `packs.ts`     | Shape-validated against an allowlist pattern in `parseArgs` before any filesystem access, rejecting path separators, `..`, and absolute paths with a usage error (exit 2). `loadPack` separately rejects any name that isn't a real `templates/packs/` directory. (`--name` never reaches a filesystem `join()` -- see the CWE-20 row.)                      |
| CWE-78 (OS Command Injection)                              | The CLI shells out for `git init` and `pnpm install`         | `git.ts` uses `execFileSync` with argv arrays exclusively -- no `shell: true`, no string-interpolated command, anywhere in `packages/cli/src`.                                                                                                                                                                                                               |
| CWE-94 (Code Injection)                                    | Templates and pack manifests are read and parsed             | No `eval`, `new Function`, or dynamic `require` of project- or template-supplied content anywhere in `packages/cli/src`; JSON/JSONC is parsed with a hand-written parser (`jsonc.ts`), never executed.                                                                                                                                                       |
| CWE-502 (Deserialization of Untrusted Data)                | An adopted project's JSON/JSONC config is read               | Parsed as data only (`jsonc.ts`), never passed to a deserializer that reconstructs class instances or prototypes; a malformed file yields a typed parse error, never a crash that leaks internals.                                                                                                                                                           |
| CWE-798 (Hardcoded Credentials)                            | Release automation touches real credentials                  | No long-lived credential is stored anywhere the tool or its CI can read: npm publishing is OIDC trusted publishing (no npm token), and secret scanning plus push protection are enabled on the repository. `.claude/hooks/guard-secret-writes.mjs` additionally blocks a real-looking secret from being written to disk during agent-assisted development.   |
| CWE-829 / CWE-1357 (Untrusted Component / Supply Chain)    | Every dependency and Action is a potential compromise vector | Every GitHub Action is pinned by commit SHA (not a floating tag); `pnpm-lock.yaml` is committed; `dependency-review.yml` fails PRs on high-severity findings; releases carry npm provenance and a Sigstore build-provenance attestation (see `SECURITY.md`, "Verifying releases").                                                                           |
| CWE-20 (Improper Input Validation)                         | General CLI argument handling                                | `tokenizeArgv`/`parseArgs` reject any unrecognized flag, a missing value for a value-flag, and contradictory mode flags, all before any side effect. `--name` is additionally validated as a syntactically valid npm package name before it's substituted into the emitted `package.json`'s _content_ -- see the CWE-22 row above for `--pack`'s path check. |
| Memory-safety CWEs (buffer overflow, use-after-free, etc.) | N/A                                                          | The entire codebase is TypeScript compiled to JavaScript running on Node's managed runtime; there is no native code and no manual memory management.                                                                                                                                                                                                         |

## Residual risks

- **A malicious pack or template contributor** is still mitigated only by
  code review, not by sandboxing -- `templates/core`/`templates/packs/`
  content is trusted because it's part of this reviewed repository, and
  that trust boundary is a deliberate design choice (see the table above),
  not an oversight. A compromised maintainer account remains the strongest
  attack this design doesn't fully counter; branch protection and required
  signed commits raise the cost but don't eliminate it.
- **Adopted projects can contain arbitrarily hostile config files**; the
  survey/grader code is written defensively against that (never execute,
  always degrade to `{ checked: 0 }`/`undetermined` rather than guess), but
  a new collector added without following that pattern would reopen this
  risk -- see `.claude/rules/src.md`'s input-validation checklist, which
  this assurance case's CWE-20/22 rows both draw on.
- **`/customize` (Phase B) runs as an LLM acting inside the user's own
  Claude Code session** with whatever tools that session has. Its
  guardrails (showing its evidence, confirming changes, staying inside the
  guidance skills' documented domains) are behavioral, not sandboxed --
  this is inherent to what Phase B is, and is disclosed in `SECURITY.md`'s
  "What you can and cannot expect" section.
