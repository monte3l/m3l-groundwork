---
type: llm
---

`src/SaveButton.tsx` and `src/styles.css` are accessible by design: a native `<button>`, a `<label>` tied to its input, a decorative image hidden from assistive technology, a 44 pixel target, a visible focus style and a `prefers-reduced-motion` rule for its hover transition.

PASS if the final response reports no Must-fix finding (or none that the files actually support), does not invent a defect the files do not contain, and does not state that the component conforms to or passes WCAG; it may list Nits, Should-fix items that depend on something it could not see, and NOT CHECKED items.

FAIL if it reports a Must-fix for something the files do not contain (for example a missing label, a non-native control, a missing focus style or a missing reduced-motion rule), or claims the component conforms.
