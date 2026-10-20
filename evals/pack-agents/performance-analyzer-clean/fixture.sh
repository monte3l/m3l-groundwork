#!/bin/sh
# SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
# SPDX-License-Identifier: MIT

set -eu
mkdir -p src/handlers src/lib
cat > src/handlers/orders.ts <<'EOF'
import { readFile } from "node:fs/promises";
import { db } from "../lib/db.js";

const PAGE_SIZE = 50;
const MAX_PAGE = 1000;

export async function listOrders(req: Request, res: Response) {
  const requested = Number(req.query.page ?? 0);
  const page = Number.isFinite(requested)
    ? Math.min(MAX_PAGE, Math.max(0, Math.trunc(requested)))
    : 0;
  const [template, orders, rates] = await Promise.all([
    readFile("./templates/order.html", "utf8"),
    db.query("SELECT id, customer_id, total FROM orders LIMIT $1 OFFSET $2", [
      PAGE_SIZE,
      page * PAGE_SIZE,
    ]),
    fetch("https://rates.example.com/latest", {
      signal: AbortSignal.timeout(5000),
    }).then((response) => response.json()),
  ]);
  const customers = await db.query(
    "SELECT id, name FROM customers WHERE id = ANY($1)",
    [orders.map((order) => order.customer_id)],
  );
  res.send(JSON.stringify({ template, orders, customers, rates }));
}
EOF
cat > src/lib/validate.ts <<'EOF'
export function isSlug(value: string): boolean {
  return value.length <= 64 && /^[a-z0-9-]+$/.test(value);
}
EOF
