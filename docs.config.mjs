// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

// Docs kit config. The kit is design/source/docs-kit/ (vendored from
// m3l-design); its README documents every key. Every tracked *.md file must
// be a page or be excluded with a reason, or
// `node design/source/docs-kit/build.mjs --check` fails.
export default {
  title: "m3l-groundwork",
  repo: "https://github.com/monte3l/m3l-groundwork",
  siteUrl: "https://groundwork.monte3l.com",
  designDir: "design",
  manifest: "packages/cli/package.json",
  navGroups: ["Start", "Project", "Security", "Internals"],
  nav: [
    { href: "index.html", label: "Docs" },
    { href: "SECURITY.html", label: "Security" },
    { href: "https://github.com/monte3l/m3l-groundwork", label: "GitHub" },
    {
      href: "https://www.npmjs.com/package/@monte3l/groundwork",
      label: "npm",
    },
  ],
  pages: [
    { src: "README.md", out: "index.html", group: "Start", label: "Overview" },
    {
      src: "CONTRIBUTING.md",
      out: "CONTRIBUTING.html",
      group: "Project",
      label: "Contributing",
    },
    {
      src: "GOVERNANCE.md",
      out: "GOVERNANCE.html",
      group: "Project",
      label: "Governance",
    },
    {
      src: "ROADMAP.md",
      out: "ROADMAP.html",
      group: "Project",
      label: "Roadmap",
    },
    {
      src: "CODE_OF_CONDUCT.md",
      out: "CODE_OF_CONDUCT.html",
      group: "Project",
      label: "Code of Conduct",
    },
    {
      src: "SECURITY.md",
      out: "SECURITY.html",
      group: "Security",
      label: "Security policy",
    },
    {
      src: "docs/assurance-case.md",
      out: "docs/assurance-case.html",
      group: "Security",
      label: "Assurance case",
    },
    {
      src: "docs/security-review.md",
      out: "docs/security-review.html",
      group: "Security",
      label: "Security review",
    },
    {
      src: "docs/architecture.md",
      out: "docs/architecture.html",
      group: "Internals",
      label: "Architecture",
    },
    {
      src: "docs/glossary.md",
      out: "docs/glossary.html",
      group: "Internals",
      label: "Glossary",
    },
  ],
  exclude: [
    {
      glob: "CLAUDE.md",
      reason: "instructions for coding agents, not reader-facing",
    },
    {
      glob: ".claude/**",
      reason: "agent rules, agents and skills, not reader-facing",
    },
    {
      glob: ".changeset/**",
      reason: "changeset tooling note, not reader-facing",
    },
    {
      glob: ".github/**",
      reason: "GitHub pull request template, not reader-facing",
    },
    {
      glob: "design/**",
      reason:
        "vendored m3l-design copy and its marker, not this project's docs",
    },
    {
      glob: "docs/research/**",
      reason: "internal refresh trackers, not reader-facing",
    },
    {
      glob: "docs/known-gaps.md",
      reason: "internal tracker, read on GitHub",
    },
    {
      glob: "docs/cloudflare-docs.md",
      reason: "pointer to the org deploy runbook, read on GitHub",
    },
    {
      glob: "docs/environment-janitor.md",
      reason: "maintainer runbook, read on GitHub",
    },
    {
      glob: "docs/github-blueprint.md",
      reason: "maintainer reference for the GitHub baseline, read on GitHub",
    },
    {
      glob: "docs/repository-layout.md",
      reason: "maintainer map of the repository, read on GitHub",
    },
    {
      glob: "packages/**",
      reason:
        "package READMEs, the cli changelog, plugin skills and eval fixtures, published through npm or the plugin, not this site",
    },
    {
      glob: "templates/**",
      reason: "files that ship into bootstrapped projects, not this site",
    },
    {
      glob: "evals/**",
      reason: "eval prompts and graders, not reader-facing",
    },
  ],
};
