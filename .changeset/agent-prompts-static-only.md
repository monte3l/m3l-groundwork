---
"@monte3l/groundwork": patch
---

pack(frontend, service): tighten the two review agents' static-review rules after a paid eval caught each breaking one. `ui-reviewer` no longer quotes a contrast ratio against a background the files never set (it must not assume white or any default, and reports the pair to measure as `NOT CHECKED`). `performance-analyzer` no longer describes a cost as slow, fast or large or gives a latency formula; it says what grows (round trips, bytes buffered, how long the event loop is blocked) and leaves how much to `NOT CHECKED`.
