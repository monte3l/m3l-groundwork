#!/usr/bin/env node
import process from "node:process";
import { main, CliUsageError } from "../dist/main.js";

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof CliUsageError ? 2 : 1;
}
