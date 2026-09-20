#!/bin/sh
# A realistic pre-existing project, then this repo's own built CLI run against
# it in adopt mode -- so .groundwork/inventory.json and adoption-report.md are
# the real handoff /customize's Step 0 reads, not a hand-written imitation.
# Adopt mode never touches a project file; the one addition it makes is a copy
# of the /customize skill, removed here so only the plugin under test is in play.
set -eu
CLI="$(cd "$(dirname "$0")/../../../cli" && pwd)/bin/m3l-groundwork.mjs"
mkdir -p .claude/agents
cat > package.json <<'JSON'
{
  "name": "legacy-service",
  "version": "1.2.0",
  "private": true,
  "scripts": { "test": "jest", "lint": "eslint ." },
  "devDependencies": { "jest": "^29.7.0", "eslint": "^8.57.0", "typescript": "^5.4.0" }
}
JSON
cat > tsconfig.json <<'JSON'
{ "compilerOptions": { "strict": true, "target": "es2020", "module": "commonjs" } }
JSON
cat > .eslintrc.cjs <<'JS'
module.exports = { root: true, extends: ["eslint:recommended"] };
JS
cat > CLAUDE.md <<'MD'
# legacy-service

## Commands
Run `npm test` before committing.
MD
cat > .claude/agents/reviewer.md <<'MD'
---
name: reviewer
description: Reviews diffs for style problems before commit.
model: opus
---
Review the diff.
MD
node "$CLI" . >/dev/null
rm -rf .claude/skills/customize
