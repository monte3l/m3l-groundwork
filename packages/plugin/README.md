# @monte3l/groundwork-plugin

**What this is:** a Claude Code plugin that tailors a project's TypeScript
and Claude Code setup to your specifics, either right after bootstrapping
it or when adopting it into an existing project.

The [m3l-groundwork](https://github.com/monte3l/m3l-groundwork) Claude Code
plugin: the `/customize` skill. For a freshly bootstrapped project it interviews
you and tailors the baseline (the standard project **harness** -- its Claude
Code agents, skills, hooks, and settings -- plus its TypeScript toolchain).
For an adopted project -- one that already existed before this tool touched
it, in **adopt mode** -- it first reconciles the CLI's survey against the
real repo. Either way it then runs a live guidance sweep over official
TypeScript and Anthropic sources.

This package is never published to npm -- it's a private workspace package,
built and typechecked like any other, but distributed only through the
central `monte3l/m3l-plugins` Claude Code marketplace (this repository ships no
marketplace of its own):

```
/plugin marketplace add monte3l/m3l-plugins
/plugin install m3l-groundwork-customize@monte3l
```

To try a local change, run `claude --plugin-dir packages/plugin` from the
repository root.

`@monte3l/groundwork` copies the same skill into a project it bootstraps, so
you only need the marketplace install if the project did not come from that
CLI. The plugin's version (`.claude-plugin/plugin.json`) tracks the CLI's for
display. The marketplace pins this plugin to a CLI release tag
(`@monte3l/groundwork@X.Y.Z`), so a change here does not reach marketplace
users when it lands on `main`: it ships after the next release
and a pin-bump PR in `monte3l/m3l-plugins`.

There's no separate changelog for the plugin -- it has no release of its
own. See [`packages/cli/CHANGELOG.md`](../cli/CHANGELOG.md) for what changed
in the version this plugin's `plugin.json` currently displays.

## What it runs, fetches and writes

The plugin is skill text and metadata. It ships **no hooks, no MCP servers and
no scripts**: Claude Code loads the `/customize` skill under `skills/` and
nothing else runs on install. Everything below happens only while you run
`/customize`. In adopt mode it confirms with you what to add and how to
resolve conflicts before it edits anything; in a freshly bootstrapped project
it acts on the answers you give in its interview.

| Does                  | What                                                                                                                                                                                                                                                                    | Where                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Reads and edits files | Applies the choices above: prunes or selects parts of the baseline, and in adopt mode reconciles the survey the CLI left                                                                                                                                                | The project you run it in. Adopt mode stages inert copies under `.groundwork/` |
| Runs commands         | `git rev-parse`, `git rev-list` and `git ls-files`; a one-line `node` that computes a SHA-256 for a staged file; `pnpm verify`, or in adopt mode `node bin/check-harness.mjs` (or a copy of the grader it puts under `.groundwork/grade/` for one run and then deletes) | The project you run it in                                                      |
| Tells you to run      | `npx @monte3l/groundwork .` when the survey is missing, incomplete or unreadable, and `git restore` to recover a report that re-run removes. The plugin runs neither itself                                                                                             | Your terminal                                                                  |
| Searches and fetches  | Claude Code's own search and fetch tools, limited by the skill to the official domains below, for the live guidance sweep in Round 2                                                                                                                                    | The public web                                                                 |

The guidance sweep only searches these domains:

| Sweep                     | Domains                                                                                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic and Claude Code | `anthropic.com`, `www.anthropic.com`, `claude.com`, `www.claude.com`, `platform.claude.com`, `code.claude.com`, `docs.claude.com`, `docs.anthropic.com`, and GitHub only under the `anthropics` organization                                                                    |
| TypeScript                | `typescriptlang.org`, `www.typescriptlang.org`, `devblogs.microsoft.com` (the `/typescript/` paths), `nodejs.org` (the `/api/` paths), `typescript-eslint.io`, `arethetypeswrong.github.io`, `publint.dev`, plus the official docs of a test or build tool your interview chose |
| Tooling gaps              | `pnpm.io`, `knip.dev`, `vitest.dev`, `eslint.org`, `prettier.io`, `docs.npmjs.com`, `nodejs.org`, plus the documentation site named in the `homepage` of a tool your project already lists under `devDependencies`                                                              |

These lists are copied from the skill's own reference files, which are the
source of truth:
[`official-sources.md`](https://github.com/monte3l/m3l-groundwork/blob/main/templates/core/.claude/skills/harness-guidance/references/official-sources.md),
[`typescript-sources.md`](https://github.com/monte3l/m3l-groundwork/blob/main/templates/core/.claude/skills/typescript-guidance/references/typescript-sources.md)
and
[`tooling-sources.md`](https://github.com/monte3l/m3l-groundwork/blob/main/templates/core/.claude/skills/typescript-guidance/references/tooling-sources.md).
If search and fetch are unavailable, the skill skips Round 2 and says so.

See the [repository README](https://github.com/monte3l/m3l-groundwork/blob/main/README.md)
for the full picture, and the
[glossary](https://github.com/monte3l/m3l-groundwork/blob/main/docs/glossary.md)
for any unfamiliar term.

MIT licensed.
