#!/bin/sh
# SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
# SPDX-License-Identifier: MIT

# A genuinely fresh bootstrap that then looks as if it had been installed from
# an older release: one file (.npmrc) is changed identically in the project,
# in its .groundwork/base/ snapshot and in the lock, and the lock's
# baseVersion is set back. This repo's own built CLI then stages the update
# with --update, so .groundwork/update/ and its plan.json are the real handoff
# /customize update reads, not a hand-written imitation. The fresh run drops a
# copy of the /customize skill under .claude/skills/; it is removed last so
# only the plugin under test is in play.
set -eu
CLI="$(cd "$(dirname "$0")/../../../cli" && pwd)/bin/m3l-groundwork.mjs"
node "$CLI" . --name eval-update-project --skip-install >/dev/null
node --input-type=module -e '
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const lockPath = ".groundwork/groundwork.lock.json";
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const entry = lock.files.find((file) => file.path === ".npmrc");
if (entry === undefined) throw new Error("the lock has no .npmrc entry");
for (const path of [".npmrc", ".groundwork/base/.npmrc.base"]) {
  appendFileSync(path, "# from an older release\n");
}
entry.baseSha256 = createHash("sha256").update(readFileSync(".npmrc")).digest("hex");
lock.baseVersion = "1.4.0";
writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
'
node "$CLI" . --update >/dev/null
rm -rf .claude/skills/customize
