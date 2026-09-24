# @monte3l/groundwork

The offline bootstrapper behind [m3l-groundwork](https://github.com/monte3l/m3l-groundwork):
one deterministic CLI that either writes a baseline TypeScript toolchain and
Claude Code harness into an empty directory (**fresh** mode) or surveys an
existing project and writes only a report (**adopt** mode, which never touches a
project file).

```bash
# 0.x is a prerelease and ships on the `next` dist-tag
npx @monte3l/groundwork@next my-new-project
npx @monte3l/groundwork@next my-new-project --pack statusline
npx @monte3l/groundwork@next ../existing-project
```

Requires Node 24+. No prompts, and no network call beyond the `pnpm install` a
fresh bootstrap ends with (`--skip-install` to skip it). Run with `--help` for
every flag, or `--list-packs` for the optional packs.

The `/customize` skill it installs, the packs, and the design are documented in
the [repository README](https://github.com/monte3l/m3l-groundwork#readme).

MIT licensed.
