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
on this repository only.

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
       live: this workflow's first real run failed with `403 Resource not
accessible by integration` under a Secrets-only grant).
     - Metadata: Read-only (mandatory minimum for any GitHub App).
   - No webhook needed; disable webhook delivery.
   - Do not grant any organization-level permission.
2. **Generate a private key** for the App (App settings → Private keys →
   Generate a private key) and note the App's Client ID.
3. **Install the App** on `monte3l/m3l-groundwork` only ("Install App" →
   "Only select repositories" → this repo). Do not install it
   organization-wide.
4. **Create the GitHub environment** the workflow's job scopes its secrets
   to, restricted to `main`:
   ```
   gh api -X PUT repos/monte3l/m3l-groundwork/environments/env-janitor \
     -f 'deployment_branch_policy[protected_branches]=false' \
     -f 'deployment_branch_policy[custom_branch_policies]=true'
   gh api -X POST repos/monte3l/m3l-groundwork/environments/env-janitor/deployment-branch-policies \
     -f name=main
   gh secret set JANITOR_APP_CLIENT_ID --env env-janitor --repo monte3l/m3l-groundwork
   gh secret set JANITOR_APP_PRIVATE_KEY --env env-janitor --repo monte3l/m3l-groundwork
   ```
5. **First run:** trigger `workflow_dispatch` with `dry_run: true` (the
   default) and read the job summary -- it lists exactly what a real run
   would deactivate, delete, and flag as drift or refused. Confirm the plan
   looks right (in particular: that `npm-publish`, and any other real
   protected environment, is never in the "Delete environments" section)
   before ever dispatching with `dry_run: false` or waiting for the
   schedule.

## Updating the policy

`.github/environments.json` lists every environment this repo's CI is
expected to have, with a retention window (`retain`) and, optionally,
`expect`ed settings to check for drift. Adding a new workflow that
references a new `environment:` name means adding it here in the same
change -- otherwise the janitor deletes it (or, if it has required reviewers
or secrets, leaves it alone and reports it as unexpected) on its next run.
