---
"@monte3l/groundwork": patch
---

An unexpected CLI failure now prints its error name (`TypeError: ...`), and setting `M3L_DEBUG` to any non-empty value also prints its stack trace. Bidirectional-text control characters in error messages are escaped like other control characters. When adopt mode has to stage the `/customize` skill at `.groundwork/customize/`, the adoption report's next step now says so, matching the console.
