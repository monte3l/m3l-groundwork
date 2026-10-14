---
"@monte3l/groundwork": major
---

First stable 1.0 release. The public API is frozen as of this release: CLI flags, modes, and exit codes; the `.groundwork/inventory.json` and `adoption-report.md` file formats; the `.groundwork/packs/` staging layout and pack names; the `engines.node` floor; and `/customize`'s invocation name. See the README's "Versioning policy" section for the full list and what's explicitly excluded (the baseline's emitted contents, which follow current upstream guidance and can still change in a minor release).

Only fixes land in the 1.0 series -- any further API change waits for 1.1. Users of the `0.x` `next` tag or a `1.0.0-rc` release must switch to `latest`: SemVer prerelease ranges don't cross from `0.1.0-next.N` or `1.0.0-rc.N` to `1.0.0` automatically.
