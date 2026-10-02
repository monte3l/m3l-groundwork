# Security assurance case

> **In plain terms:** this document explains, in detail, why this project
> is reasonably safe to use. It lists what could go wrong (a hostile
> command-line input, a compromised dependency, a tampered release), and
> for each one, what specifically stops it (input validation, pinned
> dependencies, signed releases). Most readers don't need the rest of this
> page -- it exists for anyone auditing the project's security posture in
> depth, such as for the OpenSSF Best Practices badge this document
> supports.

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
  version-PR GitHub App), `JANITOR_APP_CLIENT_ID`/`JANITOR_APP_PRIVATE_KEY`
  (the environment-cleanup GitHub App, see
  [`docs/environment-janitor.md`](environment-janitor.md)),
  `CLAUDE_CODE_OAUTH_TOKEN`, the `main` branch ruleset, and the
  `npm-publish` environment's approval gate.
- The Cloudflare API token (`docs-cloudflare` environment, `main`-only)
  that deploys the docs site, and the docs site's own served content at
  `https://groundwork.monte3l.com` -- see
  [`docs/cloudflare-docs.md`](cloudflare-docs.md).
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

| Boundary                                                       | Trusted side                                                        | Untrusted / lower-trust side                                                                 | Enforcement                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CLI `argv` → the process                                       | The CLI's own parsing logic                                         | Anything the invoker typed                                                                   | `main.ts`'s `parseArgs`/`tokenizeArgv` validate shape before any filesystem access; unknown flags and malformed values throw `CliUsageError` (exit 2), never silently proceed.                                                                                     |
| `templates/` and the plugin payload → the emitted project      | This repository's own tree, reviewed via PR                         | N/A -- this side is always trusted; it ships from this repo                                  | `assets.ts`'s `resolveAsset` locates it by a positive marker (a `pnpm-workspace.yaml` plus this repo's own `package.json` name three directories up), never by an unscoped walk that could resolve into a different, attacker-controlled tree.                     |
| An adopted project's files → the survey/grader code            | This repo's collector and grader code                               | The target project's own `eslint.config.js`, `vitest.config.ts`, `lefthook.yml`, source tree | Every collector reads facts only, never infers or executes; project code is **never run**.[^survey-scrape]                                                                                                                                                         |
| Fresh mode's own emitted project → `pnpm install`              | This repo's `git.ts`                                                | The npm registry and whatever the new project's `package.json` names                         | `execFileSync` with an argv array, never a shell string -- no command injection surface from a project name or path. This is the CLI's only network egress.                                                                                                        |
| CI `pack`/`publish` jobs → npm / GitHub                        | `release.yml`'s job boundaries                                      | The OIDC token, the npm registry                                                             | `pack` (builds, tests, packs) holds no publish credential; only `publish` holds `id-token: write`. See `CLAUDE.md`'s "Releases".[^pack-publish]                                                                                                                    |
| `claude.yml`/`claude-pr-review.yml` → the repository           | The workflow's own job                                              | A PR's contents (for the review workflow), an `@claude` mention body                         | The review workflow holds `contents: read` only and cannot push, approve, or satisfy a required check.[^claude-workflows]                                                                                                                                          |
| `docs.yml`'s `deploy` job → Cloudflare                         | The `docs-cloudflare` environment, `main`-only                      | The Cloudflare API token, the public internet edge serving the deployed site                 | The token is scoped to Workers Scripts: Edit and Workers Routes: Edit on the `monte3l.com` zone only, held as an environment secret; the job installs its own tooling with `--ignore-scripts` and runs no other repo code. See `docs/cloudflare-docs.md`.          |
| `environments.yml` → the repository's environments/deployments | A dedicated, single-purpose GitHub App, installed on this repo only | The App's `Administration: write`/`Deployments: write`/`Environments: read` token            | `bin/lib/environment-cleanup.mjs` is a pure planner; it never deletes a policy-**listed** environment, and an unlisted one with required reviewers or secrets is reported (`refused`), never deleted. See [`docs/environment-janitor.md`](environment-janitor.md). |

[^survey-scrape]:
    Config files are scraped by regex over comment-stripped
    text, not `require`d or evaluated. A scrape that can't tell the answer
    returns `{ checked: 0 }` rather than guessing.

[^pack-publish]:
    `publish` runs no repository code beyond the changesets
    CLI and a thin `pnpm`→`npm stage publish` shim, and installs with
    `--ignore-scripts`.

[^claude-workflows]:
    The mention workflow (`claude.yml`) never opens a PR
    itself -- only a branch plus a PR-creation link. `claude-pr-review.yml`
    excludes bot- and fork-authored PRs from its `if:` condition, and a
    fork can no longer open a PR here at all (pull requests are
    collaborators-only, see `CLAUDE.md`'s "Git Workflow"). `claude.yml` has
    no PR to gate -- it triggers on issues and comments, which stay open to
    everyone regardless of the pull-request policy -- so its own `if:`
    instead requires the triggering actor's `author_association` to be
    `OWNER`, `MEMBER` or `COLLABORATOR` before it runs.

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
  and `guard-branch-isolation.mjs` enforce the
  [hub-and-spoke](glossary.md#hub-and-spoke) model unconditionally.
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
  inert `.staged` copies under `.groundwork/baseline/`, and the staged pack
  files under `.groundwork/packs/` (inert `.staged` copies too, `pack.json`
  included). Both staging directories are written to a temp sibling and
  swapped in by rename, never half-written, and both refuse to run if
  `.groundwork` or a staging directory is a symlink. The one other write is
  a guarded, additive `/customize` copy -- there is no code path by
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

| CWE                                                        | Relevance                                                                                                                                                       | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CWE-22 (Path Traversal)                                    | `--pack <name>` reaches `join(root, name)` in `packs.ts`; `emitTemplate`'s per-file target path is derived from `templates/core`'s tree plus token substitution | Shape-validated against an allowlist pattern in `parseArgs` before any filesystem access, rejecting path separators, `..`, and absolute paths with a usage error (exit 2).[^cwe22] `emitTemplate` additionally asserts (`node:assert/strict`, checked live as the destination plan is built, before the first write -- exercised by `emit.test.ts`'s example-based suite, the property-based suite below, and the e2e suite) that every resolved target path stays inside `targetDir`, so a future regression fails loudly rather than escaping silently. This check is lexical (`resolve` plus a proper-prefix comparison), not symlink-aware; fresh mode adds a separate `lstat` pre-flight over every destination component and file before the first write, see "Residual risks" below. |
| CWE-78 (OS Command Injection)                              | The CLI shells out for `git init` and `pnpm install`                                                                                                            | `git.ts` uses `execFileSync` with argv arrays exclusively -- no `shell: true`, no string-interpolated command, anywhere in `packages/cli/src`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| CWE-94 (Code Injection)                                    | Templates and pack manifests are read and parsed                                                                                                                | No `eval`, `new Function`, or dynamic `require` of project- or template-supplied content anywhere in `packages/cli/src`; JSON/JSONC is parsed with a hand-written parser (`jsonc.ts`), never executed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| CWE-502 (Deserialization of Untrusted Data)                | An adopted project's JSON/JSONC config is read                                                                                                                  | Parsed as data only (`jsonc.ts`), never passed to a deserializer that reconstructs class instances or prototypes; a malformed file yields a typed parse error, never a crash that leaks internals.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| CWE-798 (Hardcoded Credentials)                            | Release automation touches real credentials                                                                                                                     | No long-lived credential is stored anywhere the tool or its CI can read: npm publishing is OIDC trusted publishing (no npm token).[^cwe798]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| CWE-829 / CWE-1357 (Untrusted Component / Supply Chain)    | Every dependency and Action is a potential compromise vector                                                                                                    | Every GitHub Action is pinned by commit SHA (not a floating tag); `pnpm-lock.yaml` is committed; `dependency-review.yml` fails PRs on high-severity findings; releases carry npm provenance and a Sigstore build-provenance attestation (see `SECURITY.md`, "Verifying releases").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| CWE-20 (Improper Input Validation)                         | General CLI argument handling                                                                                                                                   | `tokenizeArgv`/`parseArgs` reject any unrecognized flag, a missing value for a value-flag, and contradictory mode flags, all before any side effect. `--name` is additionally validated as a syntactically valid npm package name before it's substituted into the emitted `package.json`'s **content** -- see the CWE-22 row above for `--pack`'s path check.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Memory-safety CWEs (buffer overflow, use-after-free, etc.) | N/A                                                                                                                                                             | The entire codebase is TypeScript compiled to JavaScript running on Node's managed runtime; there is no native code and no manual memory management.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Beyond this table's per-CWE mitigations, `fast-check` property tests generate
input across each parser's/boundary function's full domain (rather than
hand-picked cases) on every `pnpm test` run, catching a class of edge case
example-based tests miss. See [`docs/security-review.md`](security-review.md)
for the full write-up, and `SECURITY.md`'s "Dynamic analysis".

[^cwe22]:
    `loadPack` separately rejects any name that isn't a real
    `templates/packs/` directory; `--name` never reaches a filesystem
    `join()` call at all -- see the CWE-20 row for its own validation.

[^cwe798]:
    Secret scanning and push protection are also enabled on the
    repository, and `gitleaks.yml` (`gitleaks/gitleaks-action`) runs the
    same class of check on every push, PR and weekly schedule as a
    second, independently-configured scanner over the full git history.
    `.claude/hooks/guard-secret-writes.mjs` additionally blocks a
    real-looking secret from being written to disk during agent-assisted
    development.

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
- **The path-containment checks in `emit.ts` and `main.ts`'s
  `assertAdoptWriteScope` are lexical, not symlink-aware** -- they `resolve`
  a path and compare it against the target root by string prefix, which
  does not follow a symlink. Adopt mode runs against an arbitrary,
  untrusted project directory (see the trust-boundary table above); if that
  project's `.groundwork` or `.claude/skills` entry were itself a symlink
  pointing outside the project, both checks would pass while the write
  actually landed outside it. Neither check currently calls `realpathSync`
  on the existing parent to rule this out. Accepted as a residual risk
  rather than fixed here -- adopt mode already never overwrites an existing
  project file (see "Fail-safe defaults" above), so the practical impact is
  a write escaping to a symlink target the project owner themselves created,
  not an attacker-controlled one. The staging writers and the `/customize`
  skill copy (`plugin.ts`) add an `lstat`
  refusal on `.groundwork` and the staging directories (`fs-guard.ts`); the
  skill copy never writes through a symlinked or non-directory component
  under `.claude` and instead installs into `.groundwork/customize/`, and in
  adopt mode never removes or replaces an entry the project owns under
  `.claude/skills/customize/`. It replaces files remove-then-`wx` only in the
  CLI-owned `.groundwork/customize/` and, in fresh mode under `--force`, in
  `.claude/skills/customize/`. There is,
  however, a time-of-check-to-time-of-use gap between those `lstat` checks and the
  later `rmSync` calls and writes: a local attacker able to swap a directory for a symlink in
  that window is outside the threat model this tool accepts, which assumes
  the project directory is not concurrently modified by a hostile local
  process.
- **Fresh mode's symlink check is a pre-flight, not an atomic guarantee.** Before
  the first write, fresh mode `lstat`s every directory component below the target
  and every existing destination file of the baseline and any `--pack` payload,
  and refuses (writing nothing) when one is a symlink or a non-directory where a
  directory is needed. The target directory itself and its ancestors stay
  unguarded: they are the path the user chose. So are the `.git` directory that
  `git init` creates and the `node_modules` the install step fills, which are not
  destinations of the baseline. As with the adopt-mode checks above,
  there is a time-of-check-to-time-of-use gap between this pre-flight and the
  writes, and a local attacker who can swap a component for a symlink in that
  window is outside the threat model.
- **The skill install is not fully atomic.** A pre-flight refuses a directory
  sitting at any of the skill's file names before anything is touched, and a
  failed write removes the files that run created. A failure after the install
  has begun still cannot restore what it had already replaced, in the CLI-owned
  `.groundwork/customize/` and in fresh mode under `--force` in
  `.claude/skills/customize/` (the previous copy's `SKILL.md` and each file
  removed ahead of its own rewrite; after such a failure on a fresh `--force`
  re-run the previously loadable skill is gone until a successful re-run, and
  the error says so). An entry that appears after the pre-flight, for example a
  directory created concurrently, fails the install part-way. The
  `.claude/skills/customize/` location is never replaced in adopt mode.
- **The adopt survey reads project files through symlinks** (for example
  `survey-harness.ts` reading a skill's `SKILL.md`), so a symlinked skill or
  agent file can put its frontmatter `name` and `description` from outside
  the project into `inventory.json` and the report. The read is read-only and
  limited to those frontmatter fields. Accepted as a documented limit and not
  changed here. A file the survey cannot read for lack of permission
  (`EACCES`/`EPERM`), or that vanished, loops or is a directory (`ENOENT`,
  `ELOOP`, `EISDIR`), is recorded in `undetermined` with its error code and
  the run continues; any other read error stops the run with the path and
  cause.
  An unreadable `.claude` directory (permission denied) still stops adopt mode
  in the `/customize` skill install, which reports the path and cause; making
  that install fall back to `.groundwork/customize/` is not done here.
  The harness and toolchain grades are computed from a separate read whose
  directory walks skip a directory they cannot list, so a file in such a
  directory is not graded even though the survey lists it as undetermined. A
  file that exists but cannot be read is graded as present with its read error,
  not as missing.
- **`merge-json.ts`'s three merge functions write via plain `record[key] = value`**
  with no rejection of the literal key `__proto__` -- a narrow,
  CWE-1321-shaped gap found during the 2026-09 security review (see
  `docs/security-review.md`). Its only caller today is a pack's own
  `pack.json`/`wiring` fragment, already inside this project's
  trusted-content boundary (see the table above), so it's accepted as a
  tracked residual risk rather than a live one -- tracked as
  [#48](https://github.com/monte3l/m3l-groundwork/issues/48).
- **`/customize` (Phase B) runs as an LLM acting inside the user's own
  Claude Code session** with whatever tools that session has. Its
  guardrails (showing its evidence, confirming changes, staying inside the
  guidance skills' documented domains) are behavioral, not sandboxed --
  this is inherent to what Phase B is, and is disclosed in `SECURITY.md`'s
  "What you can and cannot expect" section.
