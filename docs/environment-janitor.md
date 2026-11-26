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
4. **Create the environment and store the key in it**, once per repository.
   The baseline script creates the `env-janitor` environment and restricts it
   to `main` (read first with `--dry-run`). Then set the two secrets in it, so
   that only a job running on `main` can read them:
   ```
   bin/apply-repo-baseline.sh monte3l/m3l-groundwork --dry-run
   bin/apply-repo-baseline.sh monte3l/m3l-groundwork --apply
   bin/env-secrets.sh set JANITOR_APP_CLIENT_ID --repo m3l-groundwork
   bin/env-secrets.sh set JANITOR_APP_PRIVATE_KEY --repo m3l-groundwork < key.pem
   ```
   Both scripts are in `monte3l/.github`. Do not also share an organization
   secret of the same name with the repository: it would reach every workflow
   on every branch, and the baseline script reports it as drift.
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
the same two secrets, kept in its own `env-janitor` environment
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

`JANITOR_APP_CLIENT_ID` and `JANITOR_APP_PRIVATE_KEY` are secrets of each
repository's `env-janitor` environment, which deploys from `main` only, so only
a job running on `main` reads them. No organization secret of those names is
shared with a repository.

> [!WARNING]
> The App's key can mint an `administration: write` token for every repository
> the App is installed on, so it is kept out of the organization's secrets,
> which reach every workflow of a repository on any branch a collaborator
> pushes. Only `environments.yml` may name the two secrets: the baseline script
> reports any other workflow that does, and any organization secret of the same
> name still shared with the repository.

To rotate the key:

1. Generate a new private key in the App's settings. The old one keeps
   working.
2. Replace the secret in every repository's environment with one command,
   `bin/env-secrets.sh set JANITOR_APP_PRIVATE_KEY` in `monte3l/.github`, which
   reads the value from a hidden prompt. Run `bin/env-secrets.sh check` to
   confirm no copy was missed.
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
