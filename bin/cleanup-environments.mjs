#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * Thin I/O executor around `bin/lib/environment-cleanup.mjs`'s pure
 * `planCleanup`. Fetches this repo's current GitHub Environments and
 * Deployments over the REST API, builds the planner's input shapes, prints
 * the resulting plan, and -- unless `--dry-run` is passed -- carries it out
 * in the required order: deactivate, then delete deployments, then delete
 * environments (a deployment can only be deleted once it's inactive, or if
 * it's the repo's only deployment; deactivating first makes that always
 * true here). Exits non-zero if the plan reports `drift` or `refused`
 * environments, so either surfaces as a visibly red run rather than a
 * silently-ignored log line.
 *
 * Requires `GH_TOKEN` (a token with Administration: write, Deployments:
 * write, and Environments: read on this repo -- NOT Secrets: read, a
 * different permission category that does not cover the
 * environment-scoped secrets endpoint `hasSecrets()` below calls -- see
 * docs/environment-janitor.md for the GitHub App this is minted from) and
 * `GITHUB_REPOSITORY` (`owner/repo`, set automatically inside Actions).
 * Zero dependencies:
 * only Node's built-in `fetch`.
 */
import { appendFile, readFile } from "node:fs/promises";
import process from "node:process";
import { planCleanup } from "./lib/environment-cleanup.mjs";
import { repoRoot } from "./lib/report.mjs";

const GITHUB_API = "https://api.github.com";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `cleanup-environments: missing required environment variable ${name}`,
    );
  }
  return value;
}

async function githubRequest(token, method, path, body) {
  const response = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `cleanup-environments: ${method} ${path} failed: ${response.status} ${response.statusText} ${text}`,
    );
  }
  if (response.status === 204) return null;
  return response.json();
}

/** Pages through a `link`-relation-free, page-number-based GitHub list endpoint, stopping once a page comes back short of `per_page`. */
async function paginate(token, path, extractItems) {
  const items = [];
  let page = 1;
  for (;;) {
    const sep = path.includes("?") ? "&" : "?";
    const data = await githubRequest(
      token,
      "GET",
      `${path}${sep}per_page=100&page=${page}`,
    );
    const batch = extractItems(data);
    items.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return items;
}

/**
 * `deployment_branch_policy` can be `null` (no restriction), `{
 * protected_branches: true }` (restricted to whatever the repo's branch
 * protection covers -- a dynamic set this script does not resolve, so it's
 * reported as a fixed placeholder rather than silently treated as "no
 * restriction"), or `{ custom_branch_policies: true }` (an explicit name
 * list, fetched from the sibling deployment-branch-policies endpoint).
 */
async function branchPolicyNamesFor(token, repo, envName, branchPolicy) {
  if (!branchPolicy) return null;
  if (branchPolicy.custom_branch_policies) {
    const data = await githubRequest(
      token,
      "GET",
      `/repos/${repo}/environments/${encodeURIComponent(envName)}/deployment-branch-policies?per_page=100`,
    );
    return (data.branch_policies ?? []).map((policy) => policy.name);
  }
  if (branchPolicy.protected_branches) {
    return ["<protected-branches>"];
  }
  return null;
}

/** Requires the App's Environments permission (read) -- the generic repo-level Secrets permission does not cover this endpoint. */
async function hasSecrets(token, repo, envName) {
  const data = await githubRequest(
    token,
    "GET",
    `/repos/${repo}/environments/${encodeURIComponent(envName)}/secrets?per_page=1`,
  );
  return (data.total_count ?? 0) > 0;
}

async function fetchEnvironments(token, repo) {
  const raw = await paginate(token, `/repos/${repo}/environments`, (data) =>
    Array.isArray(data.environments) ? data.environments : [],
  );
  const environments = [];
  for (const env of raw) {
    const rules = env.protection_rules ?? [];
    const hasRequiredReviewers = rules.some(
      (rule) => rule.type === "required_reviewers",
    );
    const [branchPolicyNames, secrets] = await Promise.all([
      branchPolicyNamesFor(token, repo, env.name, env.deployment_branch_policy),
      hasSecrets(token, repo, env.name),
    ]);
    environments.push({
      name: env.name,
      hasRequiredReviewers,
      hasSecrets: secrets,
      branchPolicyNames,
    });
  }
  return environments;
}

async function latestDeploymentState(token, repo, deploymentId) {
  const statuses = await githubRequest(
    token,
    "GET",
    `/repos/${repo}/deployments/${deploymentId}/statuses?per_page=1`,
  );
  return Array.isArray(statuses) && statuses.length > 0
    ? statuses[0].state
    : null;
}

async function fetchDeployments(token, repo) {
  const raw = await paginate(token, `/repos/${repo}/deployments`, (data) =>
    Array.isArray(data) ? data : [],
  );
  const deployments = [];
  for (const deployment of raw) {
    const latestState = await latestDeploymentState(token, repo, deployment.id);
    deployments.push({
      id: deployment.id,
      environment: deployment.environment,
      createdAt: deployment.created_at,
      latestState,
    });
  }
  return deployments;
}

async function loadPolicy() {
  const root = repoRoot();
  const raw = await readFile(`${root}/.github/environments.json`, "utf8");
  const parsed = JSON.parse(raw);
  return { environments: parsed.environments ?? {} };
}

function printPlan(plan) {
  const lines = ["## Environment cleanup plan", ""];
  const section = (title, items, render) => {
    lines.push(`### ${title} (${items.length})`);
    if (items.length === 0) {
      lines.push("- none");
    } else {
      for (const item of items) lines.push(`- ${render(item)}`);
    }
    lines.push("");
  };
  section("Deactivate deployments", plan.deactivate, (id) => `#${id}`);
  section("Delete deployments", plan.deleteDeployments, (id) => `#${id}`);
  section(
    "Delete environments",
    plan.deleteEnvironments,
    (name) => `\`${name}\``,
  );
  section(
    "Drift",
    plan.drift,
    (entry) => `\`${entry.environment}\`: ${entry.issue}`,
  );
  section(
    "Refused (left untouched)",
    plan.refused,
    (entry) => `\`${entry.environment}\`: ${entry.reason}`,
  );
  const text = lines.join("\n");
  console.log(text);
  return text;
}

async function executePlan(token, repo, plan) {
  for (const id of plan.deactivate) {
    await githubRequest(
      token,
      "POST",
      `/repos/${repo}/deployments/${id}/statuses`,
      {
        state: "inactive",
        description: "cleanup: marked inactive by bin/cleanup-environments.mjs",
      },
    );
  }
  for (const id of plan.deleteDeployments) {
    await githubRequest(token, "DELETE", `/repos/${repo}/deployments/${id}`);
  }
  for (const name of plan.deleteEnvironments) {
    await githubRequest(
      token,
      "DELETE",
      `/repos/${repo}/environments/${encodeURIComponent(name)}`,
    );
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const token = requireEnv("GH_TOKEN");
  const repo = requireEnv("GITHUB_REPOSITORY");

  const [policy, environments, deployments] = await Promise.all([
    loadPolicy(),
    fetchEnvironments(token, repo),
    fetchDeployments(token, repo),
  ]);

  const plan = planCleanup({ policy, environments, deployments });
  const summary = printPlan(plan);

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    await appendFile(summaryPath, `${summary}\n`, "utf8");
  }

  if (dryRun) {
    console.log("--dry-run: no changes made.");
  } else {
    await executePlan(token, repo, plan);
    console.log("done: plan executed.");
  }

  if (plan.drift.length > 0 || plan.refused.length > 0) {
    console.error(
      "fail: drift and/or refused environments found -- see the plan above.",
    );
    process.exitCode = 1;
  }
}

await main();
