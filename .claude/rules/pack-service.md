---
paths:
  - "templates/packs/service/**"
---

# Pack rules: `service` (`templates/packs/service/**`)

> This file is the terse checklist that auto-loads when you edit the
> `service` pack. The contract every pack shares is in
> `templates/packs/README.md`.

**What it is.** The `performance-analyzer` review agent and the `api-doc`
skill (with `openapi-template.yaml` inside the skill directory). Modes: fresh
and adopt. Budget: 1 agent, 1 skill. No hooks, settings, scripts or gate.
Recommended only for the `service` project kind (`recommendService` in
`packages/plugin/src/pack-map.ts`).

- **The agent is a read-only review spoke with no shell.** Its tools are
  `Read`, `Grep` and `Glob` and nothing else, so the hub must name the files
  to review in the dispatch prompt. Keep it that way: no write tool, no
  `Bash`.
- **Its Node checklist was read from nodejs.org, not recalled.** The blocking
  API names and ReDoS shapes come from "Don't Block the Event Loop (or the
  Worker Pool)" and are pinned by
  `packages/cli/tests/templates/pack-service.test.ts`. The language-neutral
  items (N+1, unbounded queries, serial awaits, no timeout, buffering) are
  heuristics with no source and must stay labelled that way. Do not add an item
  without a source or that label.
- **It is a static source review.** Latency, throughput, memory and query
  plans are `NOT CHECKED`, never a pass. Never let it state a number it did not
  measure.
- **`api-doc` documents only routes that exist in the code.** Its OpenAPI
  rules were read from spec.openapis.org and are pinned by the same test; the
  template header names the version current when it was written. Unconfirmed
  details are `TODO` and unverified. Do not add a framework-specific template
  or a dependency, and never let it write under `src/` or `tests/`.
- **`recommended` is `true` for `service` only,** so `step-3-round-1.md`'s
  list of kind-scoped packs names it beside `publishing`, `licensing` and
  `frontend`.
- **The `budget` in `pack.json` must equal the real `files/` count.**

| Proof                     | Where                                               |
| ------------------------- | --------------------------------------------------- |
| Installs and verifies     | `packages/cli/tests/packs-service.e2e.test.ts`      |
| Manifest, agent and skill | `packages/cli/tests/templates/pack-service.test.ts` |
| Budget                    | `caps.test.ts` (checks every pack generically)      |
| Kind-gated recommendation | `packages/plugin/tests/pack-map.test.ts`            |

A change to this pack alone takes a changeset whose summary starts with
`pack(service):`.
