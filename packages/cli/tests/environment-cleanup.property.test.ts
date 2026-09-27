// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Property-based coverage for bin/lib/environment-cleanup.mjs's
 * `planCleanup` -- see SECURITY.md's "Dynamic analysis" section.
 * environment-cleanup.test.ts keeps the example-based cases; this file
 * fuzzes a small synthetic world of environments/deployments (never real
 * GitHub API data) to exercise the plan's safety guarantees as invariants:
 * a non-terminal-state deployment is never touched, every plan array only
 * references ids/names that actually exist in the input, deletion always
 * follows deactivation for a deployment that wasn't already inactive, a
 * listed environment's newest success is never deleted, and no plan array
 * ever contains a duplicate.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

type LatestState =
  | "success"
  | "failure"
  | "error"
  | "inactive"
  | "pending"
  | "queued"
  | "in_progress"
  | null;

interface EnvironmentPolicyEntry {
  retain: number | "all";
  expect?: { requiredReviewers?: boolean; branches?: string[] };
}

interface EnvironmentInfo {
  name: string;
  hasRequiredReviewers: boolean;
  hasSecrets: boolean;
  branchPolicyNames: string[] | null;
}

interface DeploymentInfo {
  id: number;
  environment: string;
  createdAt: string;
  latestState: LatestState;
}

interface CleanupPlan {
  deactivate: number[];
  deleteDeployments: number[];
  deleteEnvironments: string[];
  drift: { environment: string; issue: string }[];
  refused: { environment: string; reason: string }[];
}

interface PlanCleanupInput {
  policy: { environments: Record<string, EnvironmentPolicyEntry> };
  environments: EnvironmentInfo[];
  deployments: DeploymentInfo[];
}

// Plain ESM under bin/, outside every tsconfig -- loaded by URL (see
// design-tokens.property.test.ts for the same pattern).
const lib = (await import(
  pathToFileURL(join(repoRoot, "bin", "lib", "environment-cleanup.mjs")).href
)) as {
  planCleanup: (input: PlanCleanupInput) => CleanupPlan;
};

const NON_TERMINAL_STATES = new Set<LatestState>([
  "pending",
  "queued",
  "in_progress",
]);

const ENV_NAMES = ["alpha", "beta", "gamma", "delta"] as const;

const stateArb: fc.Arbitrary<LatestState> = fc.constantFrom(
  "success",
  "failure",
  "error",
  "inactive",
  "pending",
  "queued",
  "in_progress",
  null,
);

const branchNameArb = fc.constantFrom("main", "release", "dev");

const envSpecArb = (name: (typeof ENV_NAMES)[number]) =>
  fc.record({
    name: fc.constant(name),
    listed: fc.boolean(),
    retain: fc.oneof(
      fc.constant("all" as const),
      fc.integer({ min: 0, max: 4 }),
    ),
    hasRequiredReviewers: fc.boolean(),
    hasSecrets: fc.boolean(),
    branchPolicyNames: fc.option(fc.array(branchNameArb, { maxLength: 3 }), {
      nil: null,
    }),
    states: fc.array(stateArb, { minLength: 0, maxLength: 4 }),
  });

/**
 * Builds a small synthetic world: each of a fixed set of environment names
 * gets random settings, a random listed/unlisted status, and 0-4
 * deployments with random states. Deployment ids and `createdAt` are
 * assigned in a single global, strictly increasing sequence as the world is
 * built, so creation order is unambiguous and shrinkable.
 */
const worldArb: fc.Arbitrary<PlanCleanupInput> = fc
  .tuple(...ENV_NAMES.map((name) => envSpecArb(name)))
  .map((envSpecs) => {
    const policy: PlanCleanupInput["policy"] = { environments: {} };
    const environments: EnvironmentInfo[] = [];
    const deployments: DeploymentInfo[] = [];
    let nextId = 1;
    for (const spec of envSpecs) {
      environments.push({
        name: spec.name,
        hasRequiredReviewers: spec.hasRequiredReviewers,
        hasSecrets: spec.hasSecrets,
        branchPolicyNames: spec.branchPolicyNames,
      });
      if (spec.listed) {
        policy.environments[spec.name] = { retain: spec.retain };
      }
      for (const state of spec.states) {
        const id = nextId;
        nextId += 1;
        deployments.push({
          id,
          environment: spec.name,
          createdAt: new Date(2026, 0, 1 + id).toISOString(),
          latestState: state,
        });
      }
    }
    return { policy, environments, deployments };
  });

describe("planCleanup: property invariants", () => {
  it("never touches a deployment with a non-terminal latestState", () => {
    fc.assert(
      fc.property(worldArb, (world) => {
        const plan = lib.planCleanup(world);
        const nonTerminalIds = world.deployments
          .filter((d) => NON_TERMINAL_STATES.has(d.latestState))
          .map((d) => d.id);
        for (const id of nonTerminalIds) {
          expect(plan.deactivate).not.toContain(id);
          expect(plan.deleteDeployments).not.toContain(id);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("never references a deployment id absent from the input in deactivate or deleteDeployments", () => {
    fc.assert(
      fc.property(worldArb, (world) => {
        const plan = lib.planCleanup(world);
        const knownIds = new Set(world.deployments.map((d) => d.id));
        for (const id of [...plan.deactivate, ...plan.deleteDeployments]) {
          expect(knownIds.has(id)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("deactivates every deployment slated for deletion that wasn't already inactive", () => {
    fc.assert(
      fc.property(worldArb, (world) => {
        const plan = lib.planCleanup(world);
        const stateById = new Map(
          world.deployments.map((d) => [d.id, d.latestState]),
        );
        for (const id of plan.deleteDeployments) {
          if (stateById.get(id) !== "inactive") {
            expect(plan.deactivate).toContain(id);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("never deletes an environment that is listed in the policy", () => {
    fc.assert(
      fc.property(worldArb, (world) => {
        const plan = lib.planCleanup(world);
        for (const name of plan.deleteEnvironments) {
          expect(Object.hasOwn(world.policy.environments, name)).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("never both deletes and refuses the same environment", () => {
    fc.assert(
      fc.property(worldArb, (world) => {
        const plan = lib.planCleanup(world);
        const refusedNames = new Set(plan.refused.map((r) => r.environment));
        for (const name of plan.deleteEnvironments) {
          expect(refusedNames.has(name)).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("never deletes the newest success deployment of a listed environment", () => {
    fc.assert(
      fc.property(worldArb, (world) => {
        const plan = lib.planCleanup(world);
        for (const name of Object.keys(world.policy.environments)) {
          const remaining = world.deployments
            .filter((d) => d.environment === name)
            .filter((d) => !NON_TERMINAL_STATES.has(d.latestState))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          const newestSuccess = remaining.find(
            (d) => d.latestState === "success",
          );
          if (newestSuccess) {
            expect(plan.deleteDeployments).not.toContain(newestSuccess.id);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("never contains a duplicate id or environment name in any plan array", () => {
    fc.assert(
      fc.property(worldArb, (world) => {
        const plan = lib.planCleanup(world);
        expect(new Set(plan.deactivate).size).toBe(plan.deactivate.length);
        expect(new Set(plan.deleteDeployments).size).toBe(
          plan.deleteDeployments.length,
        );
        expect(new Set(plan.deleteEnvironments).size).toBe(
          plan.deleteEnvironments.length,
        );
        expect(new Set(plan.drift.map((d) => d.environment)).size).toBe(
          plan.drift.length,
        );
        expect(new Set(plan.refused.map((r) => r.environment)).size).toBe(
          plan.refused.length,
        );
      }),
      { numRuns: 200 },
    );
  });
});
