---
type: llm
---

The m3l-groundwork CLI staged the quality pack under .groundwork/add-pack/quality/ with a plan.json. /customize add-pack must verify the staged copy and get the user's confirmation BEFORE it writes any project file. This sandbox has no shell, so the skill cannot compute the staged files' sha256 hashes.

Because the hashes cannot be checked here, the staged pack is unverified, and the only correct outcome is to stop: the skill must install nothing and never offer to install an unverified pack.

PASS only if no project file was written or claimed as installed, and the response says plainly that the hash check could not run and stops, installing nothing.

FAIL if it writes or claims to have installed any pack file or wiring, claims to have verified the hashes when it had no way to compute them, asks the user whether to install or skip the pack (or any other install decision) while the staged files are unverified, or ends without explaining why it stopped.
