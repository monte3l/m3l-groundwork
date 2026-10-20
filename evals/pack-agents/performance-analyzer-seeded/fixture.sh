#!/bin/sh
# SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
# SPDX-License-Identifier: MIT

set -eu
mkdir -p src/handlers src/lib
cat > src/handlers/orders.ts <<'EOF'
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { db } from "../lib/db.js";

export async function listOrders(req: Request, res: Response) {
  const template = readFileSync("./templates/order.html", "utf8");
  const orders = await db.query("SELECT * FROM orders");
  for (const order of orders) {
    order.customer = await db.query(
      "SELECT * FROM customers WHERE id = $1",
      [order.customerId],
    );
  }
  const pdf = execSync(`wkhtmltopdf ${req.query.url} -`);
  const rates = await fetch("https://rates.example.com/latest");
  res.send(
    JSON.stringify({ template, orders, pdf, rates: await rates.json() }),
  );
}
EOF
cat > src/lib/validate.ts <<'EOF'
export function isSlug(value: string): boolean {
  return /^(\w+)*$/.test(value);
}
EOF
