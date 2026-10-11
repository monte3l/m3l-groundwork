---
"@monte3l/groundwork": patch
---

The shipped baseline and pack text no longer state behaviour that was never verified: `allowManagedHooksOnly` is described as upstream documents it (only managed hooks run), the `agent_id` note keeps only the guard's own rule, and the `github` and `publishing` pack workflows, pack notes and shim comments drop unverified claims about auth-error failures, private-membership `author_association` and the pnpm OIDC response. No behaviour changes.
