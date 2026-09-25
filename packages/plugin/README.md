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
built and typechecked like any other, but distributed only through the Claude
Code plugin marketplace in this same repository:

```
/plugin marketplace add monte3l/m3l-groundwork
/plugin install m3l-groundwork-customize@monte3l
```

`@monte3l/groundwork` copies the same skill into a project it bootstraps, so
you only need the marketplace install if the project did not come from that
CLI. The plugin's version (`.claude-plugin/plugin.json`) tracks the CLI's for
display; a change here ships to marketplace users the moment it lands on
`main`, independent of any npm release.

There's no separate changelog for the plugin -- it has no release of its
own. See [`packages/cli/CHANGELOG.md`](../cli/CHANGELOG.md) for what changed
in the version this plugin's `plugin.json` currently displays.

See the [repository README](https://github.com/monte3l/m3l-groundwork/blob/main/README.md)
for the full picture, and the
[glossary](https://github.com/monte3l/m3l-groundwork/blob/main/docs/glossary.md)
for any unfamiliar term.

MIT licensed.
