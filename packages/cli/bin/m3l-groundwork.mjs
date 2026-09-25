#!/usr/bin/env node
/**
 * The published CLI's entry point: `npx @monte3l/groundwork <target-dir>`
 * resolves here. Delegates straight to the built `main()` and turns a
 * `CliUsageError` into exit code 2 (a bad invocation), any other thrown
 * error into exit code 1 (a runtime failure) -- see `packages/cli/src/main.ts`.
 */
import process from "node:process";
import { main, CliUsageError } from "../dist/main.js";

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof CliUsageError ? 2 : 1;
}
