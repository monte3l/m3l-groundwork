---
"@monte3l/groundwork": patch
---

pack(service): new optional `service` pack for a project that serves an API, with a read-only `performance-analyzer` agent and an `api-doc` skill. The agent does a static review of changed server code for blocking calls (the Node.js event-loop guide's list, applied only when the project runs Node), per-request cost and unbounded work, and reports anything that needs profiling or a load test as `NOT CHECKED` instead of guessing. It has only `Read`, `Grep` and `Glob`, so the dispatch prompt must name the files to review. The skill writes an OpenAPI description from the routes the code actually defines, using a template inside the skill, marks anything it cannot confirm as `TODO` and unverified, and adds no dependency. `/customize` recommends the pack for the `service` kind only; install it with `--pack service` or from `/customize`.
