# GitHub blueprint

How this repository's GitHub setup is put together, and how to reproduce it
for a new monte3l repository. It is a reference for people setting up a
repo, not a description of the CLI. [`CLAUDE.md`](../CLAUDE.md) and the
`.claude/rules/` files stay the detailed, agent-facing source; this page
distills the parts that live on GitHub's side.

> [!NOTE]
> Everything here was read from the live repository and organization on
> 2026-09-29, and from GitHub's own documentation. The JSON files and the
> `jq` step in the checklist were checked against the live ruleset without
> writing anything. None of the commands that change settings have been run.
> Read each one against the linked GitHub docs page before running it, and
> run them yourself: they change organization and repository settings.

## Why a template repository is not enough

GitHub's template repositories copy files and, optionally, branches. GitHub
documents that much and stops there; it does not list what is left behind
([creating a template repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-template-repository)).
Community threads confirm the rest is not carried over, but those are not
official sources.

| Carried by a template repo | Not carried, needs the API or org setup   |
| -------------------------- | ----------------------------------------- |
| Files and folders          | Rulesets and branch protection            |
| Optionally all branches    | Secrets, variables and environments       |
|                            | Actions permissions and policy            |
|                            | Security features (scanning, alerts)      |
|                            | Labels and custom property values         |
|                            | Merge, auto-delete and PR-access settings |

Git LFS files are also excluded. So the blueprint splits into four layers,
each with its own delivery mechanism.

## The four layers

| Layer                    | What it holds                                                                                                                                             | Delivered by                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| L1 repo files            | Workflows, `dependabot.yml`, `LICENSE`, `CODEOWNERS` if used, `.gitattributes`, `.editorconfig`                                                           | The repo itself. In this project, `templates/core` plus the `github`, `supply-chain` and `publishing` packs. |
| L2 organization defaults | `CODE_OF_CONDUCT`, `CONTRIBUTING`, `SECURITY`, `SUPPORT`, `GOVERNANCE`, issue and PR templates, `FUNDING.yml`, `profile/README.md`, `workflow-templates/` | The public [`monte3l/.github`](https://github.com/monte3l/.github) repository                                |
| L3 per-repo settings     | Rulesets, merge settings, Actions permissions, security toggles, environments, labels, immutable releases                                                 | Repository REST API calls, scripted and idempotent                                                           |
| L4 organization policy   | Default repository permission, secret visibility, app installation scope, fork-PR approval, SHA pinning, defaults for new repositories                    | Organization settings, applied by an organization owner                                                      |

The lookup rules that shape L2, from GitHub's docs on
[default community health files](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file):

- A default file is used only when a repository has no file of that type.
- `LICENSE` cannot be a default. `CODEOWNERS` and `dependabot.yml` are not on
  the supported list either, so they stay in each repository.
- Issue templates, PR templates and `config.yml` must sit under
  `.github/ISSUE_TEMPLATE/` or `.github/`. `FUNDING.yml` must be in `.github/`.
- Workflow templates live in `workflow-templates/`, with a
  `<name>.properties.json` beside each one
  ([workflow templates](https://docs.github.com/en/actions/how-tos/reuse-automations/create-workflow-templates)).

## Reference instance: `monte3l/m3l-groundwork`

The values below are what this repository has today. Treat them as the
target for a new repository unless a row says otherwise.

### `main` ruleset (L3)

| Setting                    | Value                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| Target                     | `~DEFAULT_BRANCH`, enforcement `active`                                                          |
| Bypass actors              | None, so nobody can push, force-push or delete `main`                                            |
| Rules                      | `deletion`, `non_fast_forward`, `required_signatures`                                            |
| Pull request               | 0 approvals, thread resolution required, stale reviews dismissed on push, merge or squash only   |
| Required status checks     | `verify`, `Dependency Review` and `CodeQL`, each pinned to its producing app by `integration_id` |
| Up-to-date branch required | No (`strict_required_status_checks_policy: false`)                                               |

Why these choices: approvals are 0 because one maintainer cannot approve
their own PR. Rebase-merge is excluded because GitHub cannot sign the
rewritten commits. `strict` is off so weekly Dependabot PRs do not each
re-run every lane. `CLAUDE.md`'s "Git Workflow" has the full reasoning.

GitHub can import and export a ruleset as JSON
([managing rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/managing-rulesets-for-a-repository)),
and [`github/ruleset-recipes`](https://github.com/github/ruleset-recipes)
publishes importable examples. The `integration_id` values are GitHub's own
apps (15368 is GitHub Actions, 57789 is code scanning), so they are the same
in every organization. A check produced by a different app needs that app's
id instead.

### Environments (L3)

| Environment       | Protection                                                              | Holds                                              |
| ----------------- | ----------------------------------------------------------------------- | -------------------------------------------------- |
| `npm-publish`     | Two required reviewers, `main` only, `prevent_self_review: false` today | No secrets (npm trusted publishing uses OIDC)      |
| `docs-cloudflare` | `main` only                                                             | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`    |
| `env-janitor`     | `main` only                                                             | `JANITOR_APP_CLIENT_ID`, `JANITOR_APP_PRIVATE_KEY` |

### Actions and security (L3, L4)

| Area                                                                                                      | Today                                                | Target                                          |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------- |
| Workflow token default                                                                                    | Read-only                                            | Read-only                                       |
| Workflows approving PRs                                                                                   | Allowed                                              | Off                                             |
| Fork PR approval                                                                                          | First-time contributors                              | All external contributors                       |
| Allowed actions                                                                                           | All, SHA pinning not required                        | Selected, SHA pinning required                  |
| Secret scanning, push protection, Dependabot alerts and security updates, private vulnerability reporting | On                                                   | On                                              |
| Code scanning                                                                                             | CodeQL default setup, so no `codeql.yml` in the repo | Same                                            |
| Immutable releases                                                                                        | Off                                                  | On, once the release flow allows it (see below) |
| Tag protection                                                                                            | None                                                 | Tag ruleset                                     |

### Files that ship in the repository (L1)

Every action in every workflow is pinned by commit SHA with a version
comment, every job has a `timeout-minutes`, and top-level `permissions` are
reset and granted per job. `dependabot.yml` covers `github-actions` and the
two pinned-tool directories (`release-tools`, `deploy-tools`). Community
files at the root: `README`, `CONTRIBUTING`, `CODE_OF_CONDUCT`, `SECURITY`,
`GOVERNANCE`, `ROADMAP`, `LICENSE`. Issue forms and the PR template live
under `.github/`.

Not present, by choice or not yet: `CODEOWNERS` (deliberate, see
`SECURITY.md`), `SUPPORT.md`, `FUNDING.yml`, `.gitattributes`,
`.editorconfig`, and a `.github/release.yml` release-notes config.

## Applying the blueprint to a new repository

1. Create the repository from `templates/core` with the CLI, adding
   `--pack github`, `--pack supply-chain` and `--pack publishing` as needed.
2. Confirm the organization policy (L4) is in place. The L2 defaults come
   from [`monte3l/.github`](https://github.com/monte3l/.github), which
   needs no per-repository step.
3. Compare the new repository with the blueprint, then apply it:
   `bin/apply-repo-baseline.sh monte3l/REPO --check`, then `--apply`. The
   script and its data are in
   [`monte3l/.github`](https://github.com/monte3l/.github/tree/main/blueprint),
   and it covers the repository-scope rows of the checklist below (settings,
   Actions policy, security toggles, both rulesets, labels). Environments
   and organization policy stay manual.
4. Run `--check` again. It should report no drift.

## Settings checklist

These are the changes still pending on this repository and organization,
plus the ones a new repository needs. **An organization owner runs them.**
Replace `REPO` with the repository name.

> [!WARNING]
> Do not enable immutable releases yet. `release.yml` creates the GitHub
> Release first and then attaches assets with `gh release upload`. GitHub
> locks a release's assets when it is published as immutable
> ([announcement](https://github.blog/changelog/2025-10-28-immutable-releases-are-now-generally-available/)),
> so the upload step would fail. Change the flow to attach assets to a
> draft release before publishing, then enable the setting.

### Organization (L4)

| #   | Change                                             | Command                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Default repository permission below admin          | `gh api -X PATCH orgs/monte3l -f default_repository_permission=read`                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2   | Workflows may not approve PRs; read-only token     | `gh api -X PUT orgs/monte3l/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false`                                                                                                                                                                                                                                                                                                                                |
| 3   | Approve fork-PR runs for all external contributors | `gh api -X PUT orgs/monte3l/actions/permissions/fork-pr-contributor-approval -f approval_policy=all_external_contributors`                                                                                                                                                                                                                                                                                                                                              |
| 4   | Require SHA pinning, allow selected actions only   | `gh api -X PUT orgs/monte3l/actions/permissions -f enabled_repositories=all -f allowed_actions=selected -F sha_pinning_required=true`                                                                                                                                                                                                                                                                                                                                   |
| 5   | Allowlist for row 4                                | `gh api -X PUT orgs/monte3l/actions/permissions/selected-actions -F github_owned_allowed=true -F verified_allowed=false -f 'patterns_allowed[]=anthropics/claude-code-action@*' -f 'patterns_allowed[]=ossf/scorecard-action@*' -f 'patterns_allowed[]=gitleaks/gitleaks-action@*' -f 'patterns_allowed[]=changesets/action@*' -f 'patterns_allowed[]=changesets/action/*' -f 'patterns_allowed[]=pnpm/action-setup@*'`                                                 |
| 6   | Limit the two shared secrets to this repository    | `gh secret set CLAUDE_CODE_OAUTH_TOKEN --org monte3l --repos REPO`, and the same for `GITLEAKS_LICENSE` (each prompts for the value)                                                                                                                                                                                                                                                                                                                                    |
| 7   | Scope the Claude and Cloudflare GitHub Apps        | Organization settings, GitHub Apps, Configure, Only select repositories. The Cloudflare app does not appear in the organization's installations, so check the owner account too.                                                                                                                                                                                                                                                                                        |
| 8   | Security defaults for new repositories             | Create a code security configuration and set it as the default for new public repositories, see [choosing a security configuration](https://docs.github.com/en/code-security/securing-your-organization/introduction-to-securing-your-organization-at-scale/choosing-a-security-configuration-for-your-repositories). Enable Dependabot alerts and security updates, secret scanning, push protection, private vulnerability reporting and code scanning default setup. |

Row 4 is the largest change. Rows 4 and 5 must go together, and row 5 must
list every third-party action a workflow uses. A pattern matches the exact
`owner/repo` path, so an action referenced by sub-path needs its own
coverage: `release.yml` uses `changesets/action/pack@SHA` and three siblings,
which `changesets/action@*` does not match. That is why row 5 also allows
`changesets/action/*`. GitHub documents `*` as a general wildcard (`octocat/*` allows a
whole organization) but does not spell out sub-path matching, so treat the
first `release.yml` run after row 5 as the test, and widen the pattern only if it
fails. To recompute the list, run
`grep -rhE '^\s*-?\s*uses:' .github | sed -E 's/^\s*-?\s*uses:\s*//; s/ #.*//' | sort -u`
and remove the `actions/` and `github/` entries, which `github_owned_allowed`
covers.

### Repository (L3)

| #   | Change                                                                 | Command                                                                                                                                                                                                                                                                                                              |
| --- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | Same three Actions changes as rows 2 to 4, at repository scope         | Repeat rows 2, 3 and 4 with `repos/monte3l/REPO/actions/...` in place of `orgs/monte3l/actions/...`                                                                                                                                                                                                                  |
| 10  | Turn off rebase-merge in the repository settings, matching the ruleset | `gh api -X PATCH repos/monte3l/REPO -F allow_rebase_merge=false`                                                                                                                                                                                                                                                     |
| 11  | Labels the automation applies                                          | `gh label create dependencies --color 0366d6 --repo monte3l/REPO`. Dependabot applies it to every update PR. A repository bootstrapped from `templates/core` also needs `security` (`--color ee0701`): the baseline's scheduled audit opens its failure issue with that label. This repository has no such workflow. |
| 12  | Tag ruleset                                                            | `gh api -X POST repos/monte3l/REPO/rulesets --input tag-ruleset.json`, with the file below                                                                                                                                                                                                                           |
| 13  | Add Gitleaks to the required checks                                    | Fetch the ruleset, append the check, send it back, see below                                                                                                                                                                                                                                                         |
| 14  | Stop self-approval of npm publishes                                    | `gh api -X PUT repos/monte3l/REPO/environments/npm-publish --input npm-publish-env.json`, with the file below                                                                                                                                                                                                        |

`bin/apply-repo-baseline.sh` in `monte3l/.github` covers rows 9 to 13: the
blueprint's `main` ruleset already requires Gitleaks, so row 13 only matters
for a repository whose ruleset predates that. Row 14 is not in it, because
reviewer ids are specific to each repository.

Row 12, `tag-ruleset.json`. Tag creation stays allowed, so the release flow
can still tag. Updating or deleting a tag is blocked, and nobody can bypass
it:

```json
{
  "name": "tags",
  "target": "tag",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": { "ref_name": { "include": ["~ALL"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "update" }
  ]
}
```

Row 13. Get the ruleset id from `gh api repos/monte3l/REPO/rulesets`, then:

```sh
gh api repos/monte3l/REPO/rulesets/ID \
  | jq '{name, target, enforcement, bypass_actors, conditions, rules}
        | (.rules[] | select(.type == "required_status_checks").parameters.required_status_checks)
          += [{"context": "Gitleaks", "integration_id": 15368}]' \
  > ruleset.json
gh api -X PUT repos/monte3l/REPO/rulesets/ID --input ruleset.json
```

Gitleaks has to pass on `main` at least once first, and the check name must
match the workflow's job name exactly. Check it in the last run on `main`.

Row 14, `npm-publish-env.json`. A `PUT` replaces the environment's rules, so
the reviewers must be listed again or they are removed. The ids below are
the two current reviewers:

```json
{
  "prevent_self_review": true,
  "reviewers": [
    { "type": "User", "id": 174143562 },
    { "type": "User", "id": 175209881 }
  ],
  "deployment_branch_policy": {
    "protected_branches": false,
    "custom_branch_policies": true
  }
}
```

With `prevent_self_review` on, whoever triggers a publish cannot approve it,
so the other reviewer must. That is the point, and it means a publish waits
whenever the second reviewer is away.

After the settings are applied, update the "Known gaps" table in
`CLAUDE.md`, which currently lists the first seven as pending.

## Sources

| Topic                   | GitHub documentation                                                                                                                                                                                                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Template repositories   | [Creating a template repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-template-repository)                                                                                                                                                                                                         |
| Organization defaults   | [Creating a default community health file](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file)                                                                                                                                                                       |
| Issue forms             | [Configuring issue templates](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/configuring-issue-templates-for-your-repository)                                                                                                                                                                  |
| Rulesets                | [Managing rulesets for a repository](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/managing-rulesets-for-a-repository), [available rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets) |
| Actions hardening       | [Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)                                                                                                                                                                                                                                                            |
| Actions settings (API)  | [Permissions REST API](https://docs.github.com/en/rest/actions/permissions)                                                                                                                                                                                                                                                                         |
| Security configurations | [Choosing a security configuration](https://docs.github.com/en/code-security/securing-your-organization/introduction-to-securing-your-organization-at-scale/choosing-a-security-configuration-for-your-repositories)                                                                                                                                |
| Custom properties       | [Managing custom properties](https://docs.github.com/en/organizations/managing-organization-settings/managing-custom-properties-for-repositories-in-your-organization)                                                                                                                                                                              |

> [!NOTE]
> Organization-level rulesets need the Team plan or higher
> ([changelog](https://github.blog/changelog/2025-06-16-organization-rulesets-now-available-for-github-team-plans/)).
> The monte3l organization is on the Free plan, so rulesets are set per
> repository and custom-property targeting is not available yet.
