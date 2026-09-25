---
"@monte3l/groundwork": major
---

First 1.0 release candidate. The public API is frozen as of this release: CLI flags, modes, and exit codes; the `.groundwork/inventory.json` and `adoption-report.md` file formats; the `.groundwork/packs/` staging layout and pack names; the `engines.node` floor; and `/customize`'s invocation name. See the README's "Versioning policy" section for the full list and what's explicitly excluded (the baseline's emitted contents, which follow current upstream guidance and can still change in a minor release).

Only fixes land for the rest of the `rc` series -- any further API change waits for 1.1. `@next` users must explicitly switch to `@rc` (or wait for `@latest`); SemVer prerelease ranges don't cross from `0.1.0-next.N` to `1.0.0-rc.N` automatically.
