#!/bin/sh
# A genuinely fresh bootstrap: this repo's own built CLI emitting the baseline
# into the (empty) workspace, exactly as a user would have just run it. The
# CLI also drops a copy of the /customize skill under .claude/skills/; remove
# it so the only /customize in play is the plugin under test.
set -eu
CLI="$(cd "$(dirname "$0")/../../../cli" && pwd)/bin/m3l-groundwork.mjs"
node "$CLI" . --name eval-fresh-project --skip-install >/dev/null
rm -rf .claude/skills/customize
