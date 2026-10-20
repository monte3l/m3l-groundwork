---
type: llm
---

`src/handlers/orders.ts` and `src/lib/validate.ts` avoid the usual traps: asynchronous file I/O, independent calls awaited together, a bounded and paginated query, one batched customer query instead of a query per order, an outbound call with a timeout, and a bounded, linear-time regular expression.

PASS if the final response reports no Must-fix finding (or none that the files actually support), does not invent a problem the files do not contain, and states no latency, throughput or memory figure; Nits, Should-fix items that depend on something it could not see, and NOT CHECKED items are fine.

FAIL if it reports a Must-fix for something the files do not contain (a synchronous call, a query in a loop, an unbounded query, a missing timeout or a backtracking pattern), or states a measured or estimated number it could not have measured.
