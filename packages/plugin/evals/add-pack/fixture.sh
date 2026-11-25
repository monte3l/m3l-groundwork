#!/bin/sh
# SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
# SPDX-License-Identifier: MIT

# A genuinely fresh bootstrap, then this repo's own built CLI staging the
# quality pack into it with --add-pack -- so .groundwork/add-pack/quality/ and
# its plan.json are the real handoff /customize add-pack reads, not a
# hand-written imitation. The fresh run drops a copy of the /customize skill
# under .claude/skills/; it is removed last so only the plugin under test is
# in play.
set -eu
CLI="$(cd "$(dirname "$0")/../../../cli" && pwd)/bin/m3l-groundwork.mjs"
node "$CLI" . --name eval-add-pack-project --skip-install >/dev/null
node "$CLI" . --add-pack quality >/dev/null
rm -rf .claude/skills/customize
