---
paths:
  - ".github/workflows/environments.yml"
  - ".github/environments.json"
  - "bin/cleanup-environments.mjs"
  - "bin/lib/environment-cleanup.mjs"
---

# Environment cleanup rules (`environments.yml`, the janitor scripts)

> This file is the terse checklist that auto-loads when you touch the
> weekly GitHub Deployments/Environments cleanup. See
> `docs/environment-janitor.md` for the janitor App's exact permissions and
> one-time setup.

**Environment cleanup** (`.github/workflows/environments.yml`,
`bin/cleanup-environments.mjs`, `bin/lib/environment-cleanup.mjs`) removes
stale GitHub Deployments/Environments this repo's own CI leaves behind --
GitHub auto-creates an environment the first time a workflow job references
it and never removes it again on its own, so a renamed or retired workflow
(or one that fails partway through, as the old `pages.yml` once did before
it was replaced by `docs.yml`) leaves a permanent trail.

`bin/lib/environment-cleanup.mjs` is a pure planner (`planCleanup`) over the
repo's real environments/deployments plus `.github/environments.json`'s
policy: an environment NOT in the policy is deleted outright (its
deployments deactivated then deleted, then the environment itself), unless
it looks like a real, protected gate (required reviewers or secrets), in
which case it's left alone and reported as `refused` rather than silently
skipped or destroyed. A **listed** environment is trimmed to its policy's
retention window (always keeping its newest successful deployment) and
checked for `drift` against the policy's expected settings (required
reviewers, allowed branches) -- reported, never auto-corrected.

`bin/cleanup-environments.mjs` is the thin I/O executor (GitHub REST API via
`fetch`, zero dependencies) that always deactivates a deployment before
deleting it (GitHub's own delete rule: a repo with more than one deployment
can only delete an inactive one), and exits non-zero on any drift or refusal
so a problem surfaces as a red run rather than a buried log line. **Deleting
an environment needs Administration: write**, which the default
`GITHUB_TOKEN` cannot hold, so `environments.yml` mints a token from a
dedicated, narrowly-scoped GitHub App (installed on this repo only) rather
than widening the release workflow's own App -- see
`docs/environment-janitor.md` for the App's exact permissions and one-time
setup. Runs weekly (applying the plan) and on manual dispatch (defaulting
to `--dry-run`).
