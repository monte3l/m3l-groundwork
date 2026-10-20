#!/bin/sh
# SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
# SPDX-License-Identifier: MIT

set -eu
mkdir -p src
cat > src/SaveButton.tsx <<'EOF'
export function SaveButton({ onSave }: { onSave: () => void }) {
  return (
    <form className="save" onSubmit={(event) => event.preventDefault()}>
      <label htmlFor="note">Note</label>
      <input id="note" type="text" />
      <button type="button" className="primary" onClick={onSave}>
        <img src="/disk.svg" alt="" aria-hidden="true" />
        Save note
      </button>
    </form>
  );
}
EOF
cat > src/styles.css <<'EOF'
.primary {
  min-width: 44px;
  min-height: 44px;
}
.primary:focus-visible {
  outline: 3px solid #1a5fb4;
  outline-offset: 2px;
}
.primary:hover {
  transition: transform 300ms ease;
  transform: scale(1.05);
}
@media (prefers-reduced-motion: reduce) {
  .primary:hover {
    transition: none;
    transform: none;
  }
}
EOF
