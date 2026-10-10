# @monte3l/groundwork

**What this is:** a command-line tool that sets up a TypeScript project's
toolchain and Claude Code configuration, or reports on how an existing
project compares to that setup.

The offline bootstrapper behind [m3l-groundwork](https://github.com/monte3l/m3l-groundwork):
one deterministic CLI that either writes a baseline TypeScript toolchain and
Claude Code **harness** (its agents, skills, hooks, and settings) into an
empty directory (**fresh** mode) or surveys an existing project (**adopt
mode**, for a project that already exists and shouldn't be rewritten
automatically).

Fresh mode writes the baseline, installs any `--pack`, installs the
`/customize` skill, runs `git init`, then runs `pnpm install`. If `git init`
or `pnpm install` fails, the project is already written to disk and the error
says what to run yourself.

Adopt mode never overwrites or removes a project file. It writes a report
(`.groundwork/adoption-report.md`), an inventory (`.groundwork/inventory.json`),
and inert `.staged` copies of the baseline files your project lacks
(`.groundwork/baseline/`) and of the packs that apply
(`.groundwork/packs/`), all under `.groundwork/`. It also adds one guarded
copy of the `/customize` skill at `.claude/skills/customize/`, or at
`.groundwork/customize/` when something already there blocks it.

```bash
# currently a 1.0.0 release candidate, shipping on the `rc` dist-tag
npx @monte3l/groundwork@rc my-new-project
npx @monte3l/groundwork@rc my-new-project --pack harness-extras
npx @monte3l/groundwork@rc ../existing-project
```

Requires Node 24+. No prompts, and no network call beyond the `pnpm install` a
fresh bootstrap ends with (`--skip-install` to skip it). Run with `--help` for
every flag, or `--list-packs` for the optional packs. Exit `0` is success, `1`
is a runtime failure, and `2` is a bad invocation.

The `/customize` skill it installs, the packs, and the design are documented in
the [repository README](https://github.com/monte3l/m3l-groundwork/blob/main/README.md),
whose [versioning policy](https://github.com/monte3l/m3l-groundwork/blob/main/README.md#versioning-policy)
also lists the stable surfaces, including the adoption report's section headings.
Unfamiliar terms (harness, adopt mode, pack, and the rest) are defined in the
[glossary](https://github.com/monte3l/m3l-groundwork/blob/main/docs/glossary.md).

MIT licensed.
