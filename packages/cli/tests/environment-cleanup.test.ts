// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Covers bin/lib/environment-cleanup.mjs -- a pure planner over GitHub
 * Deployments/Environments API data (no filesystem, no network, no
 * Date.now()), plain ESM under bin/ outside every tsconfig, loaded by URL
 * (see design-tokens.test.ts / markdown.test.ts for the same pattern).
 * Exercises `planCleanup`'s full contract: terminal-state protection,
 * unlisted-environment refusal vs. deletion, listed-environment retain/keep
 * accounting, drift detection, deterministic ordering, deduplication, and
 * purity.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

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
// design-tokens.test.ts / markdown.test.ts for the same pattern).
const lib = (await import(
  pathToFileURL(join(repoRoot, "bin", "lib", "environment-cleanup.mjs")).href
)) as {
  planCleanup: (input: PlanCleanupInput) => CleanupPlan;
};

/** Deterministic ISO timestamp derived from an integer "creation rank" -- ordering is unambiguous and unrelated to a deployment's own id. */
function iso(rank: number): string {
  return new Date(2026, 0, 1 + rank).toISOString();
}

function makeEnv(
  overrides: Partial<EnvironmentInfo> & { name: string },
): EnvironmentInfo {
  return {
    hasRequiredReviewers: false,
    hasSecrets: false,
    branchPolicyNames: null,
    ...overrides,
  };
}

function makeDeployment(
  overrides: Partial<DeploymentInfo> & { id: number; environment: string },
): DeploymentInfo {
  return {
    createdAt: iso(overrides.id),
    latestState: "success",
    ...overrides,
  };
}

describe("planCleanup: terminal deployment states are never touched", () => {
  it.each(["pending", "queued", "in_progress"] as const)(
    "leaves a %s deployment out of deactivate and deleteDeployments in an unlisted, cleanup-eligible environment",
    (state) => {
      const plan = lib.planCleanup({
        policy: { environments: {} },
        environments: [makeEnv({ name: "preview" })],
        deployments: [
          makeDeployment({ id: 1, environment: "preview", latestState: state }),
        ],
      });
      expect(plan.deactivate).not.toContain(1);
      expect(plan.deleteDeployments).not.toContain(1);
    },
  );

  it.each(["pending", "queued", "in_progress"] as const)(
    "leaves a %s deployment out of deactivate and deleteDeployments in a listed environment with retain 0",
    (state) => {
      const plan = lib.planCleanup({
        policy: { environments: { production: { retain: 0 } } },
        environments: [makeEnv({ name: "production" })],
        deployments: [
          makeDeployment({
            id: 1,
            environment: "production",
            latestState: state,
          }),
        ],
      });
      expect(plan.deactivate).not.toContain(1);
      expect(plan.deleteDeployments).not.toContain(1);
    },
  );

  it("treats a null latestState the same as failure/error/inactive -- eligible for cleanup", () => {
    const plan = lib.planCleanup({
      policy: { environments: {} },
      environments: [makeEnv({ name: "preview" })],
      deployments: [
        makeDeployment({ id: 1, environment: "preview", latestState: null }),
      ],
    });
    expect(plan.deactivate).toContain(1);
    expect(plan.deleteDeployments).toContain(1);
  });
});

describe("planCleanup: unlisted environments", () => {
  it("refuses to touch an environment with required reviewers, naming the cause", () => {
    const plan = lib.planCleanup({
      policy: { environments: {} },
      environments: [
        makeEnv({ name: "prod-manual", hasRequiredReviewers: true }),
      ],
      deployments: [
        makeDeployment({
          id: 1,
          environment: "prod-manual",
          latestState: "success",
        }),
      ],
    });
    expect(plan.refused).toHaveLength(1);
    expect(plan.refused[0]?.environment).toBe("prod-manual");
    expect(plan.refused[0]?.reason).toMatch(/reviewer/i);
    expect(plan.deleteEnvironments).not.toContain("prod-manual");
    expect(plan.deactivate).not.toContain(1);
    expect(plan.deleteDeployments).not.toContain(1);
  });

  it("refuses to touch an environment with secrets, naming the cause", () => {
    const plan = lib.planCleanup({
      policy: { environments: {} },
      environments: [makeEnv({ name: "staging-secrets", hasSecrets: true })],
      deployments: [
        makeDeployment({
          id: 2,
          environment: "staging-secrets",
          latestState: "success",
        }),
      ],
    });
    expect(plan.refused).toHaveLength(1);
    expect(plan.refused[0]?.environment).toBe("staging-secrets");
    expect(plan.refused[0]?.reason).toMatch(/secret/i);
    expect(plan.deactivate).not.toContain(2);
    expect(plan.deleteDeployments).not.toContain(2);
  });

  it("gives distinguishable reason text between required-reviewers and secrets refusals", () => {
    const plan = lib.planCleanup({
      policy: { environments: {} },
      environments: [
        makeEnv({ name: "a-reviewers", hasRequiredReviewers: true }),
        makeEnv({ name: "b-secrets", hasSecrets: true }),
      ],
      deployments: [],
    });
    const byName = new Map(plan.refused.map((r) => [r.environment, r.reason]));
    const reviewersReason = byName.get("a-reviewers");
    const secretsReason = byName.get("b-secrets");
    expect(reviewersReason).toMatch(/reviewer/i);
    expect(secretsReason).toMatch(/secret/i);
    expect(reviewersReason).not.toBe(secretsReason);
  });

  it("deactivates then deletes every eligible deployment and deletes the environment when unlisted and unprotected", () => {
    const plan = lib.planCleanup({
      policy: { environments: {} },
      environments: [makeEnv({ name: "preview" })],
      deployments: [
        makeDeployment({
          id: 1,
          environment: "preview",
          createdAt: iso(1),
          latestState: "success",
        }),
        makeDeployment({
          id: 2,
          environment: "preview",
          createdAt: iso(2),
          latestState: "inactive",
        }),
      ],
    });
    expect(plan.deleteEnvironments).toContain("preview");
    // id 1 (success) isn't inactive yet -- must be deactivated first.
    expect(plan.deactivate).toEqual([1]);
    // id 2 was already inactive -- deleted without a redundant deactivation.
    expect(plan.deleteDeployments).toEqual([1, 2]);
  });
});

describe("planCleanup: listed environments -- retain/keep accounting", () => {
  it("never adds a listed environment to deleteEnvironments even when every one of its deployments is deleted", () => {
    const plan = lib.planCleanup({
      policy: { environments: { prod: { retain: 0 } } },
      environments: [makeEnv({ name: "prod" })],
      deployments: [
        makeDeployment({
          id: 1,
          environment: "prod",
          createdAt: iso(1),
          latestState: "failure",
        }),
      ],
    });
    expect(plan.deleteEnvironments).not.toContain("prod");
  });

  it("keeps only the newest success when retain is 0", () => {
    const plan = lib.planCleanup({
      policy: { environments: { prod: { retain: 0 } } },
      environments: [makeEnv({ name: "prod" })],
      deployments: [
        makeDeployment({
          id: 1,
          environment: "prod",
          createdAt: iso(1),
          latestState: "success",
        }),
        makeDeployment({
          id: 2,
          environment: "prod",
          createdAt: iso(2),
          latestState: "failure",
        }),
        makeDeployment({
          id: 3,
          environment: "prod",
          createdAt: iso(3),
          latestState: "success",
        }),
      ],
    });
    // id 3 is the newest success -- kept. id 1 (older success) and id 2 are deleted.
    expect(plan.deleteDeployments.slice().sort((a, b) => a - b)).toEqual([
      1, 2,
    ]);
    expect(plan.deleteDeployments).not.toContain(3);
  });

  it('keeps every remaining deployment when retain is "all"', () => {
    const plan = lib.planCleanup({
      policy: { environments: { prod: { retain: "all" } } },
      environments: [makeEnv({ name: "prod" })],
      deployments: [
        makeDeployment({
          id: 1,
          environment: "prod",
          createdAt: iso(1),
          latestState: "failure",
        }),
        makeDeployment({
          id: 2,
          environment: "prod",
          createdAt: iso(2),
          latestState: "error",
        }),
      ],
    });
    expect(plan.deactivate).toEqual([]);
    expect(plan.deleteDeployments).toEqual([]);
  });

  it("keeps the newest N deployments plus the newest success even if it falls outside the retained window", () => {
    const plan = lib.planCleanup({
      policy: { environments: { prod: { retain: 1 } } },
      environments: [makeEnv({ name: "prod" })],
      deployments: [
        makeDeployment({
          id: 1,
          environment: "prod",
          createdAt: iso(1),
          latestState: "success",
        }), // oldest, but the only success
        makeDeployment({
          id: 2,
          environment: "prod",
          createdAt: iso(2),
          latestState: "failure",
        }),
        makeDeployment({
          id: 3,
          environment: "prod",
          createdAt: iso(3),
          latestState: "failure",
        }),
        makeDeployment({
          id: 4,
          environment: "prod",
          createdAt: iso(4),
          latestState: "failure",
        }), // newest
      ],
    });
    // keepSet = {newest success (1), newest 1 (4)}; delete 2 and 3.
    expect(plan.deleteDeployments.slice().sort((a, b) => a - b)).toEqual([
      2, 3,
    ]);
    expect(plan.deactivate.slice().sort((a, b) => a - b)).toEqual([2, 3]);
    expect(plan.deleteDeployments).not.toContain(1);
    expect(plan.deleteDeployments).not.toContain(4);
  });

  it("keeps everything when retain is a number larger than the number of remaining deployments", () => {
    const plan = lib.planCleanup({
      policy: { environments: { prod: { retain: 10 } } },
      environments: [makeEnv({ name: "prod" })],
      deployments: [
        makeDeployment({
          id: 1,
          environment: "prod",
          createdAt: iso(1),
          latestState: "failure",
        }),
        makeDeployment({
          id: 2,
          environment: "prod",
          createdAt: iso(2),
          latestState: "failure",
        }),
      ],
    });
    expect(plan.deleteDeployments).toEqual([]);
    expect(plan.deactivate).toEqual([]);
  });

  it("does not re-deactivate an already-inactive deployment slated for deletion, but still deletes it", () => {
    const plan = lib.planCleanup({
      policy: { environments: { prod: { retain: 0 } } },
      environments: [makeEnv({ name: "prod" })],
      deployments: [
        makeDeployment({
          id: 1,
          environment: "prod",
          createdAt: iso(1),
          latestState: "inactive",
        }),
        makeDeployment({
          id: 2,
          environment: "prod",
          createdAt: iso(2),
          latestState: "success",
        }),
      ],
    });
    expect(plan.deactivate).toEqual([]);
    expect(plan.deleteDeployments).toEqual([1]);
  });

  it("excludes non-terminal-state deployments from the 'remaining' set used for retain accounting, even when chronologically newest", () => {
    const plan = lib.planCleanup({
      policy: { environments: { prod: { retain: 1 } } },
      environments: [makeEnv({ name: "prod" })],
      deployments: [
        makeDeployment({
          id: 10,
          environment: "prod",
          createdAt: iso(1),
          latestState: "failure",
        }),
        makeDeployment({
          id: 30,
          environment: "prod",
          createdAt: iso(2),
          latestState: "failure",
        }),
        makeDeployment({
          id: 20,
          environment: "prod",
          createdAt: iso(3),
          latestState: "pending",
        }),
      ],
    });
    // If the pending deployment (chronologically newest) were wrongly
    // counted toward the retain(1) window, id 30 would lose its slot and
    // get deleted too -- it must not be.
    expect(plan.deleteDeployments).toEqual([10]);
    expect(plan.deactivate).toEqual([10]);
    expect(plan.deleteDeployments).not.toContain(20);
    expect(plan.deactivate).not.toContain(20);
  });
});

describe("planCleanup: drift", () => {
  it("reports drift when policy expects requiredReviewers but the environment lacks it", () => {
    const plan = lib.planCleanup({
      policy: {
        environments: {
          prod: { retain: "all", expect: { requiredReviewers: true } },
        },
      },
      environments: [makeEnv({ name: "prod", hasRequiredReviewers: false })],
      deployments: [],
    });
    expect(plan.drift).toHaveLength(1);
    expect(plan.drift[0]?.environment).toBe("prod");
    expect(plan.drift[0]?.issue).toMatch(/reviewer/i);
  });

  it("reports no drift when actual settings match expect", () => {
    const plan = lib.planCleanup({
      policy: {
        environments: {
          prod: {
            retain: "all",
            expect: { requiredReviewers: true, branches: ["main"] },
          },
        },
      },
      environments: [
        makeEnv({
          name: "prod",
          hasRequiredReviewers: true,
          branchPolicyNames: ["main"],
        }),
      ],
      deployments: [],
    });
    expect(plan.drift).toEqual([]);
  });

  it("reports no drift when the policy entry has no expect at all", () => {
    const plan = lib.planCleanup({
      policy: { environments: { prod: { retain: "all" } } },
      environments: [makeEnv({ name: "prod", hasRequiredReviewers: false })],
      deployments: [],
    });
    expect(plan.drift).toEqual([]);
  });

  it("treats expect.branches as an unordered set match", () => {
    const plan = lib.planCleanup({
      policy: {
        environments: {
          prod: { retain: "all", expect: { branches: ["main", "release"] } },
        },
      },
      environments: [
        makeEnv({ name: "prod", branchPolicyNames: ["release", "main"] }),
      ],
      deployments: [],
    });
    expect(plan.drift).toEqual([]);
  });

  it("reports drift when expect.branches differs from the actual set", () => {
    const plan = lib.planCleanup({
      policy: {
        environments: {
          prod: { retain: "all", expect: { branches: ["main"] } },
        },
      },
      environments: [makeEnv({ name: "prod", branchPolicyNames: ["develop"] })],
      deployments: [],
    });
    expect(plan.drift).toHaveLength(1);
    expect(plan.drift[0]?.environment).toBe("prod");
  });

  it("reports drift mentioning 'no branch restriction' when expect.branches names branches but the environment has none", () => {
    const plan = lib.planCleanup({
      policy: {
        environments: {
          prod: { retain: "all", expect: { branches: ["main"] } },
        },
      },
      environments: [makeEnv({ name: "prod", branchPolicyNames: null })],
      deployments: [],
    });
    expect(plan.drift).toHaveLength(1);
    expect(plan.drift[0]?.environment).toBe("prod");
    expect(plan.drift[0]?.issue).toMatch(/no branch restriction/i);
  });

  it("never reports drift for a refused, unlisted environment", () => {
    const plan = lib.planCleanup({
      policy: { environments: {} },
      environments: [makeEnv({ name: "prod", hasRequiredReviewers: true })],
      deployments: [],
    });
    expect(plan.drift).toEqual([]);
  });
});

describe("planCleanup: deterministic ordering", () => {
  it("sorts deactivate and deleteDeployments ascending by numeric id regardless of input order", () => {
    const plan = lib.planCleanup({
      policy: { environments: {} },
      environments: [makeEnv({ name: "preview" })],
      deployments: [
        makeDeployment({
          id: 30,
          environment: "preview",
          createdAt: iso(30),
          latestState: "failure",
        }),
        makeDeployment({
          id: 5,
          environment: "preview",
          createdAt: iso(5),
          latestState: "error",
        }),
        makeDeployment({
          id: 100,
          environment: "preview",
          createdAt: iso(100),
          latestState: "failure",
        }),
      ],
    });
    expect(plan.deactivate).toEqual([5, 30, 100]);
    expect(plan.deleteDeployments).toEqual([5, 30, 100]);
  });

  it("sorts deleteEnvironments alphabetically", () => {
    const plan = lib.planCleanup({
      policy: { environments: {} },
      environments: [
        makeEnv({ name: "zeta" }),
        makeEnv({ name: "alpha" }),
        makeEnv({ name: "mu" }),
      ],
      deployments: [],
    });
    expect(plan.deleteEnvironments).toEqual(["alpha", "mu", "zeta"]);
  });

  it("sorts drift and refused alphabetically by environment", () => {
    const plan = lib.planCleanup({
      policy: {
        environments: {
          zeta: { retain: "all", expect: { requiredReviewers: true } },
          alpha: { retain: "all", expect: { requiredReviewers: true } },
        },
      },
      environments: [
        makeEnv({ name: "zeta", hasRequiredReviewers: false }),
        makeEnv({ name: "alpha", hasRequiredReviewers: false }),
        makeEnv({ name: "z-refused", hasSecrets: true }),
        makeEnv({ name: "a-refused", hasRequiredReviewers: true }),
      ],
      deployments: [],
    });
    expect(plan.drift.map((d) => d.environment)).toEqual(["alpha", "zeta"]);
    expect(plan.refused.map((r) => r.environment)).toEqual([
      "a-refused",
      "z-refused",
    ]);
  });
});

describe("planCleanup: no duplicates anywhere", () => {
  it("de-duplicates a deployment id that appears more than once in the input", () => {
    const dup = makeDeployment({
      id: 1,
      environment: "preview",
      latestState: "failure",
    });
    const plan = lib.planCleanup({
      policy: { environments: {} },
      environments: [makeEnv({ name: "preview" })],
      deployments: [dup, { ...dup }],
    });
    expect(plan.deactivate.filter((id) => id === 1)).toHaveLength(1);
    expect(plan.deleteDeployments.filter((id) => id === 1)).toHaveLength(1);
  });

  it("de-duplicates an environment name that appears more than once in environments", () => {
    const plan = lib.planCleanup({
      policy: { environments: {} },
      environments: [
        makeEnv({ name: "preview" }),
        makeEnv({ name: "preview" }),
      ],
      deployments: [],
    });
    expect(plan.deleteEnvironments.filter((n) => n === "preview")).toHaveLength(
      1,
    );
  });
});

describe("planCleanup: purity", () => {
  it("returns deep-equal results for repeated calls with fresh-but-equal input, and does not mutate its input", () => {
    function buildInput(): PlanCleanupInput {
      return {
        policy: {
          environments: {
            prod: { retain: 1, expect: { requiredReviewers: true } },
          },
        },
        environments: [
          makeEnv({ name: "prod", hasRequiredReviewers: false }),
          makeEnv({ name: "preview" }),
        ],
        deployments: [
          makeDeployment({
            id: 1,
            environment: "prod",
            createdAt: iso(1),
            latestState: "success",
          }),
          makeDeployment({
            id: 2,
            environment: "prod",
            createdAt: iso(2),
            latestState: "failure",
          }),
          makeDeployment({
            id: 3,
            environment: "preview",
            createdAt: iso(3),
            latestState: "inactive",
          }),
        ],
      };
    }

    const inputA = buildInput();
    const inputB = buildInput();
    const environmentsBefore = structuredClone(inputA.environments);
    const deploymentsBefore = structuredClone(inputA.deployments);

    const resultA = lib.planCleanup(inputA);
    const resultB = lib.planCleanup(inputB);

    expect(resultA).toEqual(resultB);
    expect(inputA.environments).toEqual(environmentsBefore);
    expect(inputA.deployments).toEqual(deploymentsBefore);
  });
});
