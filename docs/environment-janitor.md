# Environment cleanup: setup and runbook

`.github/workflows/environments.yml` removes stale GitHub
Deployments/Environments this repo's own CI leaves behind -- see
`CLAUDE.md`'s "Architecture notes" for the design record ("Environment
cleanup"). This file is the one-time setup this pipeline depends on.

Deleting a GitHub **environment** requires the `Administration: write`
repository permission, which the default `GITHUB_TOKEN` cannot hold at any
scope. Rather than widen the release workflow's existing GitHub App (used
for the version-PR flow, see `CLAUDE.md`'s "Releases") with that broad a
permission, this pipeline uses its own, single-purpose GitHub App, installed
on selected repositories only.

## One-time setup (done by hand)

1. **Create the GitHub App** (org settings → Developer settings → GitHub
   Apps → New GitHub App), named e.g. `monte3l-env-janitor`.
   - **Repository permissions:**
     - Administration: **Read and write** (required to delete an
       environment: `DELETE /repos/{owner}/{repo}/environments/{name}`).
     - Deployments: **Read and write** (required to deactivate/delete a
       deployment).
     - Environments: **Read-only** (lets the planner tell whether an
       unlisted environment holds secrets, so it's refused rather than
       deleted -- see `bin/lib/environment-cleanup.mjs`'s safety rail).
       **Not** the "Secrets" permission -- that category covers only
       repository-level Actions secrets and does not grant access to
       `GET /repos/{owner}/{repo}/environments/{name}/secrets` (confirmed
       live: [run 36318745169](https://github.com/monte3l/m3l-groundwork/actions/runs/36318745169)
       on 2026-09-27 failed with `403 Resource not accessible by
integration` under a Secrets-only grant).
     - Metadata: Read-only (mandatory minimum for any GitHub App).
   - No webhook needed; disable webhook delivery.
   - Do not grant any organization-level permission.
2. **Generate a private key** for the App (App settings → Private keys →
   Generate a private key) and note the App's Client ID.
3. **Install the App** on the repositories that run the cleanup ("Install
   App" → "Only select repositories"). Do not install it organization-wide.
4. **Store the key as organization secrets**, once, shared with those
   repositories only (visibility `selected`), the same way as
   `GITLEAKS_LICENSE`:
   ```
   gh secret set JANITOR_APP_CLIENT_ID --org monte3l --visibility selected --repos <repo,...>
   gh secret set JANITOR_APP_PRIVATE_KEY --org monte3l --visibility selected --repos <repo,...> < key.pem
   ```
   Then, per repository, let the baseline script create the `env-janitor`
   environment, restrict it to `main` and share the two secrets with the
   repository (read first with `--dry-run`):
   ```
   bin/apply-repo-baseline.sh monte3l/m3l-groundwork --dry-run
   bin/apply-repo-baseline.sh monte3l/m3l-groundwork --apply
   ```
   The script is in `monte3l/.github`. It never creates a secret and never
   deletes one. Do not also set the secrets on the `env-janitor`
   environment: an environment secret overrides the org one, so a leftover
   copy keeps an old key alive after a rotation.
5. **First run:** trigger `workflow_dispatch` with `dry_run: true` (the
   default) and read the job summary -- it lists exactly what a real run
   would deactivate, delete, and flag as drift or refused. Confirm the plan
   looks right (in particular: that `npm-publish`, and any other real
   protected environment, is never in the "Delete environments" section)
   before ever dispatching with `dry_run: false` or waiting for the
   schedule.

## Other repositories

The rest of the monte3l repositories run this same pipeline through the org
workflow template (`monte3l/.github`, `workflow-templates/environments.yml`).
It checks out this repository's `bin/` at a pinned commit and runs
`bin/cleanup-environments.mjs` against the calling repository's own
`.github/environments.json`, so there is one copy of the planner. Each
repository is covered by the same `monte3l-env-janitor` App installation and
the same two organization secrets, and has its own `env-janitor` environment
(steps 3 and 4 above, with its own name in place of `m3l-groundwork`).

The script's interface is therefore a contract with those repositories: the
policy path and format, `--dry-run`, `GH_TOKEN` and `GITHUB_REPOSITORY`. A
breaking change here needs a new pin in each of them.

`monte3l/.github`'s `bin/apply-repo-baseline.sh` reports a consumer whose pin
is off `main` or predates the newest commit touching the planner's files:
`bin/cleanup-environments.mjs`, `bin/lib/environment-cleanup.mjs`,
`bin/lib/report.mjs` and `bin/lib/term.mjs`. A pin that merely trails `main` is
fine. If the planner starts importing another file, add it to `janitor_files`
in that script in the same change.

## Secrets and rotation

`JANITOR_APP_CLIENT_ID` and `JANITOR_APP_PRIVATE_KEY` are organization
secrets with visibility `selected`, shared with each repository that runs the
cleanup. The environment holds no secrets.

> [!WARNING]
> An organization secret reaches every workflow in each repository it is
> shared with, on any branch a collaborator pushes, where an environment secret
> reached only the job running on `main`. Only `environments.yml` may name the
> two secrets: the baseline script reports any other workflow that does.

To rotate the key:

1. Generate a new private key in the App's settings. The old one keeps
   working.
2. Replace the secret: `gh secret set JANITOR_APP_PRIVATE_KEY --org monte3l`.
   The repository list is kept.
3. Dispatch `environments.yml` with `dry_run` on in one repository and confirm
   it succeeds.
4. Delete the old key in the App's settings.

Rotate at least once a year, since the key does not expire, and at once on any
exposure or when someone with access leaves.

## Updating the policy

`.github/environments.json` lists every environment this repo's CI is
expected to have, with a retention window (`retain`) and, optionally,
`expect`ed settings to check for drift. Adding a new workflow that
references a new `environment:` name means adding it here in the same
change -- otherwise the janitor deletes it (or, if it has required reviewers
or secrets, leaves it alone and reports it under the plan's "Refused (left untouched)"
section) on its next run.
