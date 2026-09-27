---
name: triaging-scan-alerts
description: >-
  Fetches this repository's open code-scanning alerts via gh api, groups
  them by tool and severity, and maps each to its file:line -- the output
  is a triage report and options only, it never edits code. Use for
  /triaging-scan-alerts, "review the scan alerts", "what does CodeQL flag",
  "triage the security findings", or after a code-scanning workflow run.
  GitHub stance: gh CLI.
---

Fetch every open code-scanning alert for this repository, group it by
which tool raised it and how severe it is, and map each to the exact
file and line it points at. This skill produces a report and a set of
options per alert -- it never edits code, dismisses an alert, or opens a
PR on its own.

## Steps

### 1 — Fetch open alerts

```bash
gh api 'repos/{owner}/{repo}/code-scanning/alerts?state=open' \
  --paginate \
  -q '.[] | {number, tool: .tool.name, severity: .rule.security_severity_level // .rule.severity, rule: .rule.id, path: .most_recent_instance.location.path, line: .most_recent_instance.location.start_line, description: .rule.description}'
```

(`state=open` is in the query string, not a `-f` field -- `gh api` switches
to `POST` the moment any `-f`/`-F` field is passed without an explicit
`--method GET`, which would break this list call. The whole path is single-
quoted because `?` is a glob character in zsh -- macOS's default shell --
and an unquoted one there fails with "no matches found" before `gh` runs.)

Use the current repository (`gh` infers `{owner}/{repo}` from the working
directory's remote when the placeholders are left as-is). If the endpoint
returns a 404 or a permissions error, code scanning may not be enabled on
this repository -- report that plainly rather than treating it as "no
alerts".

### 2 — Group by tool and severity

Group the results by `tool` (CodeQL, a third-party SARIF uploader, etc.)
first, then by `severity` within each tool (`critical`/`high`/`medium`/
`low`, or the tool's own scale if it doesn't use those exact words --
report the tool's own label rather than forcing it into one of the four).

### 3 — Map each alert to file:line

Every alert in the fetched output already carries `path`/`line` from its
most recent instance -- present these verbatim (`path:line`) so the user
can jump straight to the code. If `path`/`line` is absent (some
alert-generating tools don't localize to a line), say so rather than
inventing a location.

### 4 — Present the report

One table per tool, ordered severity-first: alert number, rule id, one-line
description, `path:line`, severity. Note the total open-alert count at the
top.

### 5 — Offer options per alert -- never act automatically

For each alert, describe (not perform) the realistic options:

- **fix now**: a one-line description of what the fix would look like, if
  obvious from the rule/description -- this skill still does not make the
  edit itself; the option is to hand it to a code-writing task.
- **dismiss as false positive** / **won't fix** / **used in tests**: the
  three reasons GitHub's own dismissal UI accepts, named but not run:
  ```bash
  gh api -X PATCH repos/{owner}/{repo}/code-scanning/alerts/{number} \
    -f state=dismissed -f "dismissed_reason=false positive"
  ```
  (swap the quoted value for `won't fix` or `used in tests` -- each contains
  a space or apostrophe, so it must stay quoted as one shell argument).
- **needs a human decision**: for anything ambiguous (a finding in
  generated code, a suppressed pattern that might be intentional).

Ask the user which option applies before running any dismissal command --
this skill's own default is to report, not to close anything out.

### 6 — Note the adjacent alert surfaces this skill doesn't cover

Dependabot alerts (`gh api repos/{owner}/{repo}/dependabot/alerts`) and
secret-scanning alerts (`gh api repos/{owner}/{repo}/secret-scanning/alerts`)
are separate GitHub endpoints from code-scanning -- if the user asks about
either, say so and fetch that endpoint too rather than assuming this
skill's code-scanning report already covers it.
