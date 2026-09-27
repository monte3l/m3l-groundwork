// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * A pure planner for GitHub Environments/Deployments cleanup: given a
 * retention policy plus already-fetched environment and deployment facts, it
 * decides which deployments to deactivate and delete, which environments to
 * delete, which listed environments have drifted from the policy's
 * expectations, and which unlisted environments it refuses to touch.
 *
 * No filesystem, no network, no clock -- every input arrives as an argument
 * and the result is a plain data plan, so the I/O wrapper that executes it
 * can be dry-run and the planning logic tested in isolation. The plan is
 * deterministic (every array sorted, no duplicates) and never mutates its
 * input.
 *
 * Safety rules, in the order they bite:
 *
 * - A deployment whose `latestState` is `pending`, `queued` or `in_progress`
 *   is never touched and never counts toward a retain window.
 * - An environment the policy does not list, but which carries required
 *   reviewers or secrets, is refused outright -- deleting it would destroy a
 *   protection or a credential this planner has no way to recreate.
 * - A listed environment is never deleted, and its newest `success`
 *   deployment is always kept, whatever `retain` says.
 * - A deployment only reaches `deleteDeployments` after `deactivate`, unless
 *   it is already `inactive` (GitHub refuses to delete an active one).
 */

/**
 * @typedef {"success" | "failure" | "error" | "inactive" | "pending"
 *   | "queued" | "in_progress" | null} LatestState
 */

/**
 * @typedef {object} EnvironmentExpectation
 * @property {boolean} [requiredReviewers] Whether the environment should
 *   have required reviewers configured.
 * @property {string[]} [branches] The exact (unordered) set of deployment
 *   branch policy names the environment should restrict to.
 */

/**
 * @typedef {object} EnvironmentPolicyEntry
 * @property {number | "all"} retain How many of the newest cleanup-eligible
 *   deployments to keep, beyond the newest `success` (always kept).
 * @property {EnvironmentExpectation} [expect] Settings to check for drift.
 */

/**
 * @typedef {object} CleanupPolicy
 * @property {Record<string, EnvironmentPolicyEntry>} environments Every
 *   environment the repo intends to keep, keyed by name.
 */

/**
 * @typedef {object} EnvironmentInfo
 * @property {string} name
 * @property {boolean} hasRequiredReviewers
 * @property {boolean} hasSecrets
 * @property {string[] | null} branchPolicyNames `null` when the environment
 *   has no deployment branch restriction at all.
 */

/**
 * @typedef {object} DeploymentInfo
 * @property {number} id
 * @property {string} environment
 * @property {string} createdAt ISO-8601 timestamp.
 * @property {LatestState} latestState The state of the deployment's most
 *   recent status, or `null` when it has none.
 */

/**
 * @typedef {object} CleanupInput
 * @property {CleanupPolicy} policy
 * @property {EnvironmentInfo[]} environments
 * @property {DeploymentInfo[]} deployments
 */

/**
 * @typedef {object} CleanupPlan
 * @property {number[]} deactivate Deployment ids to mark inactive, ascending.
 * @property {number[]} deleteDeployments Deployment ids to delete, ascending.
 * @property {string[]} deleteEnvironments Environment names to delete,
 *   alphabetical.
 * @property {{ environment: string, issue: string }[]} drift One entry per
 *   drifted environment (several mismatches are joined with `; `), sorted
 *   by environment.
 * @property {{ environment: string, reason: string }[]} refused Unlisted
 *   environments left alone because they are protected, sorted by
 *   environment.
 */

const NON_TERMINAL_STATES = new Set(["pending", "queued", "in_progress"]);

/** Newest `createdAt` first; ties broken by higher id first, so the order is total. */
function newestFirst(a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return b.id - a.id;
}

/** Plain-code-unit comparison, so ordering never depends on the host locale. */
function byString(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Why an unlisted environment must be refused, or `null` if it is safe to delete. */
function refusalReason(env) {
  const causes = [];
  if (env.hasRequiredReviewers) causes.push("it has required reviewers");
  if (env.hasSecrets) causes.push("it has environment secrets");
  if (causes.length === 0) return null;
  return `not listed in the policy, but ${causes.join(" and ")} -- refusing to delete it`;
}

/** Every drift issue between a listed environment's settings and its `expect`. */
function driftIssues(env, expectation) {
  if (expectation === undefined) return [];
  const issues = [];
  if (
    expectation.requiredReviewers !== undefined &&
    expectation.requiredReviewers !== env.hasRequiredReviewers
  ) {
    issues.push(
      expectation.requiredReviewers
        ? "expected required reviewers, but none are configured"
        : "expected no required reviewers, but some are configured",
    );
  }
  if (expectation.branches !== undefined) {
    const expected = [...new Set(expectation.branches)].sort(byString);
    if (env.branchPolicyNames === null) {
      if (expected.length > 0) {
        issues.push(
          `expected branches [${expected.join(", ")}], but the environment has no branch restriction`,
        );
      }
    } else {
      const actual = [...new Set(env.branchPolicyNames)].sort(byString);
      const same =
        actual.length === expected.length &&
        actual.every((name, i) => name === expected[i]);
      if (!same) {
        issues.push(
          `expected branches [${expected.join(", ")}], but found [${actual.join(", ")}]`,
        );
      }
    }
  }
  return issues;
}

/** The deployments of a listed environment that fall outside its keep set. */
function listedDiscards(remaining, retain) {
  const keep = new Set();
  const newestSuccess = remaining.find((d) => d.latestState === "success");
  if (newestSuccess !== undefined) keep.add(newestSuccess.id);
  const window = retain === "all" ? remaining : remaining.slice(0, retain);
  for (const d of window) keep.add(d.id);
  return remaining.filter((d) => !keep.has(d.id));
}

/**
 * Plans an environment/deployment cleanup against a retention policy.
 *
 * Environments and deployments are de-duplicated by name and id (the first
 * occurrence wins). A deployment whose environment is absent from
 * `environments` is left alone: without that environment's facts there is no
 * way to know whether it is protected.
 *
 * @param {CleanupInput} input
 * @returns {CleanupPlan}
 *
 * @example
 * ```js
 * import { planCleanup } from "./environment-cleanup.mjs";
 *
 * const plan = planCleanup({
 *   policy: { environments: { production: { retain: 3 } } },
 *   environments: [
 *     { name: "production", hasRequiredReviewers: true, hasSecrets: true, branchPolicyNames: ["main"] },
 *     { name: "preview-42", hasRequiredReviewers: false, hasSecrets: false, branchPolicyNames: null },
 *   ],
 *   deployments: [
 *     { id: 7, environment: "preview-42", createdAt: "2026-09-01T00:00:00.000Z", latestState: "success" },
 *   ],
 * });
 * // plan.deactivate -> [7]; plan.deleteDeployments -> [7];
 * // plan.deleteEnvironments -> ["preview-42"]
 * ```
 */
export function planCleanup({ policy, environments, deployments }) {
  const envByName = new Map();
  for (const env of environments) {
    if (!envByName.has(env.name)) envByName.set(env.name, env);
  }

  const deploymentsByEnv = new Map();
  const seenIds = new Set();
  for (const d of deployments) {
    if (seenIds.has(d.id)) continue;
    seenIds.add(d.id);
    if (NON_TERMINAL_STATES.has(d.latestState)) continue;
    const list = deploymentsByEnv.get(d.environment);
    if (list === undefined) deploymentsByEnv.set(d.environment, [d]);
    else list.push(d);
  }

  const discard = [];
  const deleteEnvironments = [];
  const drift = [];
  const refused = [];

  for (const env of envByName.values()) {
    const eligible = [...(deploymentsByEnv.get(env.name) ?? [])];
    if (Object.hasOwn(policy.environments, env.name)) {
      const entry = policy.environments[env.name];
      eligible.sort(newestFirst);
      discard.push(...listedDiscards(eligible, entry.retain));
      const issues = driftIssues(env, entry.expect);
      if (issues.length > 0) {
        drift.push({ environment: env.name, issue: issues.join("; ") });
      }
      continue;
    }
    const reason = refusalReason(env);
    if (reason !== null) {
      refused.push({ environment: env.name, reason });
      continue;
    }
    discard.push(...eligible);
    deleteEnvironments.push(env.name);
  }

  const byId = (a, b) => a - b;
  return {
    deactivate: discard
      .filter((d) => d.latestState !== "inactive")
      .map((d) => d.id)
      .sort(byId),
    deleteDeployments: discard.map((d) => d.id).sort(byId),
    deleteEnvironments: deleteEnvironments.sort(byString),
    drift: drift.sort((a, b) => byString(a.environment, b.environment)),
    refused: refused.sort((a, b) => byString(a.environment, b.environment)),
  };
}
