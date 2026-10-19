---
"@monte3l/groundwork": patch
---

pack(claude-github): the Claude Code GitHub Action workflows (`claude.yml` and `claude-pr-review.yml`) move out of the `github` pack into a new `claude-github` pack, so the `gh`-CLI skills can be adopted without a workflow that needs an auth secret and spends API credits on every pull request. `--pack github` no longer emits either workflow; pass `--pack github --pack claude-github` for the previous set. `/customize` recommends `claude-github` for no project kind by default. A project that already installed `github` keeps its files untouched.
