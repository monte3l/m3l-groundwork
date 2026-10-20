#!/bin/sh
# SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
# SPDX-License-Identifier: MIT

set -eu
mkdir -p src
cat > src/SearchBox.tsx <<'EOF'
export function SearchBox({ onSearch }: { onSearch: (query: string) => void }) {
  return (
    <div className="search">
      <img src="/magnifier.svg" />
      <input type="text" placeholder="Search products" />
      <div className="go" onClick={() => onSearch("")}>
        Go
      </div>
    </div>
  );
}
EOF
cat > src/styles.css <<'EOF'
.search input {
  outline: none;
  border: 1px solid #ccc;
}
.go {
  width: 16px;
  height: 16px;
  cursor: pointer;
}
.go:hover {
  transition: transform 300ms ease;
  transform: scale(1.4);
}
EOF
