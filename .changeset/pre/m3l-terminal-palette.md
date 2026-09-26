---
"@monte3l/groundwork": patch
---

Console output now paints a handful of status lines (`✓ ... is ready`, the adoption report's `✓` line, and an over-cap warning) in m3l-design's terminal palette, when color is supported: never when `NO_COLOR` is set, always when `FORCE_COLOR` is set to anything but `"0"`, and otherwise only on a real TTY. Non-interactive output (the common case for CI and for every existing test in this repo) is byte-identical to before this change -- nothing in the CLI's documented public API (flags, modes, exit codes, `.groundwork/` file contents) changed.
