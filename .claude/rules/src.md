---
paths:
  - "packages/*/src/**"
---

# Source rules (`packages/*/src/**`)

> This file is the terse checklist that auto-loads when you edit source.
> Base standards — TypeScript strictness, ESM `.js` imports, named exports,
> exporting a type next to its value, `readonly`/`const`, `interface` vs
> `type`, exhaustive `switch`, TSDoc on every export — live in CLAUDE.md and
> `eslint.config.js`; this file adds what those don't already say.

- **Don't pass `undefined` to an optional property.** Under
  `exactOptionalPropertyTypes`, an optional target field (`default?: number`)
  rejects an explicit `undefined` (TS2379). When forwarding optional caller
  options into a strict target, **omit the key** with a conditional spread —
  `...(v !== undefined ? { k: v } : {})` — never `{ k: someValue | undefined }`.
- **Guard reads and writes together when mutating a property on an object you
  don't own — verify success by reading it back, never by the absence of a
  throw.** The property can be an accessor whose getter itself throws, the
  object can be frozen/sealed/non-extensible, or a setter can silently no-op.
  Wrap the read AND the write in one `try`/`catch`, and after a non-throwing
  assignment compare `object.property === value` before reporting success.
- **Never export error-constructor options interfaces.** Callers _catch_
  errors, they don't construct them.
- **Discriminate a swallow by error `code`, not class.** When one error class
  carries several `code`s, `catch (e) { if (e instanceof X) skip }` drops the
  very failures the codes distinguish. Narrow the skip to the specific benign
  `code` and **re-throw** the rest.
- **Guard the parse step, not just the read and the validation around it.**
  A read-then-`JSON.parse`-then-validate sequence needs the same typed-error
  treatment on all three steps. Do **not** chain a raw `SyntaxError` as
  `cause` when the file may hold sensitive content — Node embeds a snippet of
  the malformed content in the message, and the cause chain carries it
  forward to a log/stderr sink.
- **Fail loud on caller/config errors; stay lenient only on external data.**
  Validate caller- and config-supplied input at the public boundary and throw
  a typed error on violation. Reserve tolerant handling (skip / default /
  warn) for data you don't control (file contents, network payloads).
- **Narrow a `try`/`catch` to just the fallible call, never the
  post-processing.** Wrapping response-mapping inside the same `try` as an
  async SDK/IO call mislabels a future local bug in the mapping as an upstream
  failure. Assign the awaited result inside `try`/`catch`, build the return
  value after the `catch` block resolves.
- **Co-locate by a shared value, not by shared code.** When two independent
  mechanisms must agree on a derived path/id/name, give ONE owner the raw
  value and have both derive the result through a single shared helper —
  never let each capture its own copy and re-derive independently, which
  drifts silently.
- **Never put a bare URL in TSDoc.** Reference sibling modules with `{@link
Symbol}` or a backticked relative path. Nothing validates link targets, so an
  invented host survives review by eye — grep new source for `http` before
  committing.
- **`Object.hasOwn(record, field)`, not `record[field] !== undefined`, when
  reading a field off untrusted or partially-trusted input.** Bracket access
  walks the prototype chain, so a record with no own `field` (e.g. one
  literally named `"__proto__"`) can silently resolve an inherited — or,
  under prototype pollution, attacker-controlled — value instead of the
  "absent" the caller expects.
- **Validate a local copy, never the property expression — `Object.hasOwn`
  guards _presence_, not _stability_.** Each mention of `x.f` is a **separate
  read**, and an accessor may answer differently every time:
  ```ts
  // BAD — three reads; the value returned is not the value validated
  const bad = typeof e.n === "number" && Number.isFinite(e.n) ? e.n : null;
  // GOOD — one read
  const raw: unknown = e.n;
  const good = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  ```
- **A cast across a serialization boundary hides the PROTOTYPE, not just the
  shape.** A stream that rebuilds nodes with a null prototype can answer
  `Array.isArray === true` while the array has no `.slice`. Re-hydrate with
  `structuredClone` first, never `JSON.parse(JSON.stringify(...))`, which
  also turns `-0` into `0` behind the narrowing layer.
- **Allowlist, never denylist, for a redaction or sanitization boundary.**
  Enumerate the fields you keep; drop everything else. A pattern that tries
  to _recognize_ what is unsafe (a regex over URLs, key-name heuristics) is a
  denylist against unbounded input and does not converge. Where the input is
  genuinely free text, say "best effort" in the TSDoc and reclassify the
  artifact instead of promising a guarantee.
- **Every caller-supplied value crossing the public boundary is validated
  once, at the boundary — including depth and recursion bounds — and that
  validation's guarantee must hold all the way to where the value is used.**
  Two hazards: **(1) never validate a caller value and then let something
  else re-read it** — a non-idempotent getter, a non-enumerable own `toJSON`
  invisible to `Object.keys` but applied by the serializer. Do the traversal
  **once**: validate and project into a fresh structure, then derive the
  downstream artifact from the projection, never the original. **(2) an
  unbounded recursion or loop over caller-supplied structure is itself
  unvalidated input**, even when every individual read is guarded — depth
  and iteration count need their own explicit ceiling, checked before
  recursing, not discovered as a bare `RangeError`/stack overflow at runtime.
- **`JSON.stringify` is typed `string` but returns `undefined`** — for a bare
  `undefined`, a function, a symbol, or an object whose `toJSON()` returns
  one. A template literal launders that into the text `"undefined"`, which
  writes and hashes cleanly and parses as nothing. Assert it is a string
  before measuring, writing, or digesting it.
- **A TSDoc sentence asserting a security or correctness property is a claim
  to verify, not prose to write.** After the last contract change of a task,
  re-read every guarantee sentence against the code, not against the plan. A
  "never surfaced to the caller"-style claim needs a **per-channel** audit: a
  resolved value and a thrown error's `cause`/`message` are separate
  observable channels, and a claim proven true for one can still be false
  for the other.
- **"Additive" is about construction, not just consumption.** Before calling
  an added field on an options/context type additive, grep the whole repo —
  tests included — for hand-construction of that type. A **required** field
  added to any type that a caller or a test fake _constructs_ is
  source-breaking, even when production code only ever _receives_ it.
- **Trust the CLI gate over the IDE/LSP.** Editor diagnostics lag and
  misreport against the project `tsconfig`. A passing `pnpm typecheck` /
  `pnpm lint` is the source of truth — don't chase a red squiggle the CLI
  says is clean.
