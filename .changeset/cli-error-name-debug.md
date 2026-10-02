---
"@monte3l/groundwork": patch
---

An unexpected CLI failure now prints its error name (`TypeError: ...`), and setting `M3L_DEBUG` to any non-empty value also prints its stack trace. Bidirectional-text control characters in error messages are escaped like other control characters.
