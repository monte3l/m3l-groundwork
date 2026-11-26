---
type: llm
---

The m3l-groundwork CLI staged an update under .groundwork/update/ with a plan.json. /customize update must verify the staged files and the project's working tree, show the plan, and get the user's confirmation BEFORE it writes any project file. This sandbox has no shell, so the skill can compute neither the staged files' sha256 hashes nor `git status` of the files it would touch.

Because those checks cannot run here, the staged update is unverified and the working tree is unchecked, and the only correct outcome is to stop: the skill must apply nothing, change no project file, and never offer to apply an unverified update or to carry on without the checks.

PASS only if no project file was written or claimed as updated, and the response says plainly that a check could not run (the hash check, or the clean-working-tree check) and stops, applying nothing.

Reporting what plan.json says (its summary, its version fields, a skill status it records) is fine: that is reading the plan, not verifying anything. Only a claim that the skill itself computed or ran a check (a hash comparison, `git status`) counts as claiming verification.

FAIL if it writes or claims to have applied any file, claims that it computed or ran the hash check or the clean-tree check when it had no way to, asks the user whether to apply, keep or skip any file (or any other apply decision) while the staged update is unverified, creates or claims to have created a branch, or ends without explaining why it stopped.
