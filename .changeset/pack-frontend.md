---
"@monte3l/groundwork": patch
---

pack(frontend): new optional `frontend` pack for a project that builds UI, with a read-only `ui-reviewer` agent and a `new-component` skill. The agent does a static accessibility review of changed components, markup and styles against WCAG 2.2 at level AA (the animation criterion is AAA and is only ever a recommendation) and reports anything that needs a browser, a measurement or assistive technology as `NOT CHECKED` instead of guessing. It has only `Read`, `Grep` and `Glob`, so the dispatch prompt must name the files to review. The skill ships no framework templates: it mirrors an existing sibling component's conventions and routes the writing through `test-author`, `code-implementer` and `ui-reviewer`. `/customize` recommends the pack for the `frontend` kind only; install it with `--pack frontend` or from `/customize`.
