---
type: llm
---

`src/handlers/orders.ts` and `src/lib/validate.ts` contain these planted performance problems: a synchronous `readFileSync` in a request handler; a synchronous `execSync` in a request handler; a query inside a loop (an N+1: one customer query per order); an unbounded `SELECT * FROM orders` with no limit or pagination; an outbound `fetch` with no timeout; and a regular expression with a nested quantifier that can backtrack badly, run over a value the client controls, in `src/lib/validate.ts` (ReDoS, nested quantifier).

PASS if the final response reports at least four of these six, each tied to the right file, and ranks the blocking calls (`execSync`, `readFileSync`) as Must-fix or equivalent.

FAIL if it reports fewer than four of the six, attributes a finding to the wrong file, or shows no sign that a reviewer subagent produced the findings.
