---
paths:
  - "**/tests/**"
  - "**/*.test.ts"
---

# Testing rules (`tests/**`, `*.test.ts`)

> This file is the terse checklist that auto-loads when you edit a test.

- **Assert the named behavior, not a proxy** — not `length > 0`, and not
  merely that the call "doesn't throw". A positive and a negative claim
  BOTH met by nothing happening need the positive one asserted explicitly
  too.
- **A test that claims to guard something must be mutation-tested before you
  believe it guards anything** — delete the guard clause, invert the flag,
  drop a wrapper, and confirm the test fails.
- **A surviving mutant is a question, not automatically a defect — and a
  mutation that never applied is not a survivor at all.** An _equivalent_
  mutant (both branches agree on every reachable input under a
  runtime-enforced invariant) needs a note, not a new test; verify a
  scripted mutation actually changed the file before trusting a "survivor".
- **A check whose two sides come from ONE source can never fail** — a fake
  store that ECHOES the value under test passes either way. Pin at least
  one side by hand.
- **A mutation-tested guard can go vacuous LATER** — it proves teeth only at
  the moment you run it. When a change adds a consumer of a signal a test
  observes INDIRECTLY (a property read, a call count), re-mutate the tests
  watching it.
- **Never make a test double wait by counting event-loop turns** — a
  `setImmediate` retry-N-times loop is a latency guess passing locally and
  failing under CI load. Anchor the emit to a structural guarantee instead.
- **Rebuild before trusting a cross-package result.** If tests resolve a
  sibling package through its build output rather than its source, run the
  build first — a stale `dist/` fails tests in an untouched package after an
  export changes, and a `src/` edit never reaches a consumer's suite until
  rebuilt.
- **A test naming a precedence, ordering, or "every X" guarantee must make
  every arm reachable in its own setup** — exactly right yet prove nothing
  if the discriminating precondition never fires. Enumerate the set
  (`test.each`), not one member of it.
- **Never mock the behavior the test exists to validate** — a stub echoing
  back the outcome under question asserts the stub, not the code, while
  still reading as coverage. Exercise the real collaborator at least once.
- **No network; real filesystem only inside a per-test `mkdtemp` sandbox**,
  torn down in the same test. An integration-test directory that genuinely
  needs the real network is the one deliberate exception — mark it clearly
  and keep it out of the default unit run.
- **A type-only `expectTypeOf` test still executes its expression at
  runtime** — if it invokes a fallible async method, resolve the mock to a
  valid value first, or a rejecting un-awaited promise surfaces despite the
  type assertion passing.
- **A gate failing outside your change's blast radius is presumed
  pre-existing until disambiguated** — `git diff origin/main -- <path>`
  settles it in seconds. Not licence to retry blind: an unexplained green
  re-run is itself a flake to diagnose and file.
- **Mock an SDK package the same way once it mixes class and data
  exports** — a plain `vi.mock("pkg", () => ({...}))` object literal
  silently omits unlisted exports, harmless for a type-only import but
  fatal once a value import (a data-only enum) resolves to `undefined` at
  module-load time. Default to an `importOriginal`-preserving async factory.
- **A dynamic-`import()`-only step module can mock with a plain `const
stepMock = vi.fn()`; once production code adds a _static_ import from that
  module, move the mock to `vi.hoisted(() => vi.fn())`** — a plain `const`
  initializes after `vi.mock` calls are hoisted.
- **Mock a port with generic methods by inference, not `extends`** — a
  generic method (`select<Value>(...)`) can't be mocked via `interface Mock
extends Port { ... }` (TS2430). Let the factory return the inferred
  `vi.fn()` object instead.
- **Test-first, not test-after** — write tests from the documented contract,
  watch them fail for the right reason, then implement — don't backfill a
  test that just mirrors code you already wrote.
- **Justify intentional `eslint-disable` on the error channel** — a test
  proving normalization throws non-`Error` values on purpose, tripping
  `only-throw-error`. Disable narrowly with a `--` rationale:

```ts
// eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional non-Error to verify the unknown channel
throw "a string";
```

- **Assemble a secret-shaped fixture at runtime, never as a single source
  literal**, if this repo runs a secret scanner over source text —
  concatenate two substrings instead of writing the shape whole.

### Test-tooling gotchas

- **`not.toHaveProperty` cannot prove own-key absence** — chai falls back to
  `"key" in Object(obj)` and walks the prototype chain. Assert
  `Object.hasOwn(result, "f")` instead, and restore a polluted prototype in
  an **unconditional** `afterEach` (`Reflect.deleteProperty`,
  `configurable: true`).
- **Runtime-green ≠ typecheck-green** — Vitest transforms without
  type-checking, so run `pnpm typecheck` as its own gate on every test file
  you touch.
- **`pnpm build` is a distinct gate from `pnpm typecheck`, not a slower
  version of it** — `isolatedDeclarations` (the `tsconfig.build.json`
  project only) makes an additive `as const satisfies` pass `typecheck` and
  fail `build` with TS9010. Any exported-type change needs both.
- **A test that deliberately avoids importing from `src` can strand an
  export and fail `pnpm knip`** — keep both a hand-authored table and an
  import for projection identity. `knip` is not gated in `pre-push` by
  default — run it yourself after touching any export.
- **eslint runs in-loop** (prettier → eslint → typecheck → vitest) —
  resolve findings as you write, don't defer to a later `pnpm lint` pass.
- **Thread `now` as an injectable parameter on a time-dependent guard**
  rather than defaulting to `Date.now()` inside it — a sibling function's
  fixed-timestamp fixtures are the tell.
- **Read coverage from `coverage/coverage-final.json`, not the
  `pnpm test:coverage` text table.** The v8 text reporter omits files that
  are 100% on every metric, so an absent file in the table is not an
  uncovered file.
- **A fix round adding branches isn't done until the _gated_ run passes** —
  per-file thresholds run only under `test:coverage`, never a scoped
  `vitest` call. Trace the gap from `coverage-final.json`'s uncovered-line
  list and cover any new ternary's non-`Error` arm in the same edit.
- **A suite failing while a spoke fan-out is running may be contention, not
  a regression — re-run it alone first.**
- Use `pnpm exec vitest`; a bare `npx vitest` can fail to resolve
  `@vitest/coverage-v8` under pnpm.
- **Brace void-union handler bodies** — a handler typed `void |
Promise<void>` whose arrow body returns a value fails typecheck (TS2322);
  the leniency applies only to a return type of _exactly_ `void`. Wrap the
  body: `() => { arr.push(v); }`.
- **Never explicitly parameterize `vi.spyOn<T, S>`'s return type** — an
  explicit type argument resolves against the first overload regardless of
  which one the call matches, failing a method spy with a `never`-constraint
  error though the runtime call is correct. Let TypeScript infer it from the
  `return` statement instead.
