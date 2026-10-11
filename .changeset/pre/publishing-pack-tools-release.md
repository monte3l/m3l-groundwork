---
"@monte3l/groundwork": patch
---

The `publishing` pack now ships its pinned npm at `tools/release/` instead of `.github/release-tools/`, and `release.yml` installs from there. Dependabot cannot open a PR that changes files under a repository's root `.github/` outside `workflows/` (the update fails with a 400 "invalid or unauthorized changes"), so the old location never received bump PRs. A project that already installed the pack keeps working unchanged; to get Dependabot updates, move `.github/release-tools/` to `tools/release/`, update the two paths in its `release.yml`, and add an `npm` entry for `/tools/release` to its `dependabot.yml`.
