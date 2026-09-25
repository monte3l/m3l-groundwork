# @monte3l/groundwork

**What this is:** a command-line tool that sets up a TypeScript project's
toolchain and Claude Code configuration, or reports on how an existing
project compares to that setup.

The offline bootstrapper behind [m3l-groundwork](https://github.com/monte3l/m3l-groundwork):
one deterministic CLI that either writes a baseline TypeScript toolchain and
Claude Code **harness** (its agents, skills, hooks, and settings) into an
empty directory (**fresh** mode) or surveys an existing project and writes
only a report (**adopt mode**, which never touches a project file --
it's for a project that already exists and shouldn't be rewritten
automatically).

```bash
# currently a 1.0.0 release candidate, shipping on the `rc` dist-tag
npx @monte3l/groundwork@rc my-new-project
npx @monte3l/groundwork@rc my-new-project --pack statusline
npx @monte3l/groundwork@rc ../existing-project
```

Requires Node 24+. No prompts, and no network call beyond the `pnpm install` a
fresh bootstrap ends with (`--skip-install` to skip it). Run with `--help` for
every flag, or `--list-packs` for the optional packs.

The `/customize` skill it installs, the packs, and the design are documented in
the [repository README](https://github.com/monte3l/m3l-groundwork/blob/main/README.md).
Unfamiliar terms (harness, adopt mode, pack, and the rest) are defined in the
[glossary](https://github.com/monte3l/m3l-groundwork/blob/main/docs/glossary.md).

MIT licensed.
