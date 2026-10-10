---
"@monte3l/groundwork": patch
---

The `publishing` pack's shipped security note (in its `adoptNotes`) now covers all five packages bundled inside the pinned npm that carry open advisories, not three: it adds postcss-selector-parser 7.1.4 and http-cache-semantics 4.2.0, with why neither is reached from the shipped release workflow. Its "bump as soon as" criterion now includes postcss-selector-parser >= 7.1.6 and names the open upstream fixes (npm/cli#10088 and #10089), and it says http-cache-semantics has no fixed release (4.3.0 is outside the advisory's range, but upstream closed the report as not planned), so a bump past 4.2.0 only clears its alert. Dated 2026-10-08.
