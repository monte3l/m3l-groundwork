# @monte3l/groundwork-plugin

The [m3l-groundwork](https://github.com/monte3l/m3l-groundwork) Claude Code
plugin: the `/customize` skill. For a freshly bootstrapped project it interviews
you and tailors the baseline; for an adopted project it first reconciles the
CLI's survey against the real repo. Either way it then runs a live guidance pass
over official TypeScript and Anthropic sources.

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

MIT licensed.
