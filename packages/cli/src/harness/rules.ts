// SPDX-FileCopyrightText: Copyright the m3l-groundwork contributors
// SPDX-License-Identifier: MIT

/**
 * The harness rule set: a declarative list of checks, each a pure function
 * over a `HarnessSnapshot` (everything the grader read from disk, already in
 * memory). Rules never touch the filesystem, so they are testable without
 * temp directories and cannot drift on I/O behaviour.
 *
 * Structural rules encode wiring integrity. Rubric rules encode Anthropic's
 * published guidance (skill body at most 500 lines, a scoped tool list, a
 * description substantial enough to trigger on) and only ever warn.
 *
 * `templates/core/bin/lib/harness-rules.mjs` is the emitted ESM twin of this
 * file; `tests/harness-parity.test.ts` runs both over the real baseline and
 * asserts identical findings, so the two cannot silently diverge.
 */
import { isRecord } from "../merge-json.js";
import { fieldList, fieldText, parseFrontmatter } from "./frontmatter.js";
import type { HarnessCategory, RuleLevel } from "./types.js";

export interface SkillSnapshot {
  /** The skill's directory name. */
  name: string;
  /** `SKILL.md`'s text, or `undefined` when the file is missing. */
  skillMd: string | undefined;
  /** Every file under the skill directory, relative to it. */
  files: string[];
}

export interface HarnessSnapshot {
  settings: { present: boolean; error: string | undefined; parsed: unknown };
  /** `.claude/settings.local.json`, parsed, or `undefined` when absent/unparseable. */
  settingsLocal: unknown;
  /**
   * Why `.claude/settings.local.json` failed to parse, or `undefined` when it
   * parsed or is absent -- the distinction `settingsLocal` alone cannot make.
   */
  settingsLocalError: string | undefined;
  /** Hook filename to source text. */
  hooks: Map<string, string>;
  /** Agent filename (with `.md`) to text. */
  agents: Map<string, string>;
  skills: SkillSnapshot[];
  /** Rule filename (with `.md`) to text. */
  rules: Map<string, string>;
  claudeMd: string | undefined;
  /** Every file and directory under `.claude/`, as project-relative paths. */
  claudeTree: Set<string>;
  /** Every project file (bounded walk), as project-relative paths. */
  projectFiles: string[];
}

interface RuleFailure {
  subject: string;
  message: string;
}

interface RuleResult {
  /** How many subjects the rule examined -- the denominator of the rubric score. */
  checked: number;
  failures: RuleFailure[];
}

export interface HarnessRule {
  id: string;
  level: RuleLevel;
  category: HarnessCategory;
  check: (snapshot: HarnessSnapshot) => RuleResult;
}

/**
 * Model ids and aliases considered current. Bump alongside the
 * `harness-guidance` refresh sweep; `templates/core/bin/lib/harness-rules.mjs`
 * carries the same list and the parity test keeps the two equal.
 */
export const CURRENT_MODELS: readonly string[] = [
  "inherit",
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-sonnet-5",
  "claude-fable-5-1",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
];

const SKILL_BODY_LINE_LIMIT = 500;
const DESCRIPTION_MIN = 40;
const DESCRIPTION_MAX = 1024;
const BARE_ENTRY_POINT =
  /process\.argv\[1\]\s*===\s*fileURLToPath\(import\.meta\.url\)/;
// Contains `realpathSync(process.argv[1])`, but compares it to a URL-encoded
// pathname rather than an OS path -- the two never agree under a symlinked
// or percent-encoded path, so this form fails open too.
const URL_PATHNAME_ENTRY_POINT =
  /realpathSync\(process\.argv\[1\]\)\s*===\s*new URL\(import\.meta\.url\)\.pathname/;
const HOOK_PATH = /\.claude\/hooks\/([A-Za-z0-9_.-]+)/g;
const CLAUDE_PATH = /\.claude\/[A-Za-z0-9_.*/-]+/g;
const REFERENCE_PATH = /\breferences\/[A-Za-z0-9_./-]+\.md/g;

interface HookRegistration {
  event: string;
  command: string;
  hasTimeout: boolean;
}

function hookRegistrations(settings: unknown): HookRegistration[] {
  if (!isRecord(settings) || !isRecord(settings["hooks"])) return [];
  const registrations: HookRegistration[] = [];
  for (const [event, entries] of Object.entries(settings["hooks"])) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries as unknown[]) {
      if (!isRecord(entry) || !Array.isArray(entry["hooks"])) continue;
      for (const hook of entry["hooks"] as unknown[]) {
        if (!isRecord(hook) || typeof hook["command"] !== "string") continue;
        registrations.push({
          event,
          command: hook["command"],
          hasTimeout: typeof hook["timeout"] === "number",
        });
      }
    }
  }
  return registrations;
}

function allRegistrations(snapshot: HarnessSnapshot): HookRegistration[] {
  return [
    ...hookRegistrations(snapshot.settings.parsed),
    ...hookRegistrations(snapshot.settingsLocal),
  ];
}

/** Every string anywhere inside a parsed JSON value. */
function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return (value as unknown[]).flatMap(collectStrings);
  }
  if (isRecord(value)) return Object.values(value).flatMap(collectStrings);
  return [];
}

/**
 * Hook files named by any command in settings -- `hooks` registrations and
 * also top-level command keys such as `statusLine` -- named directly, since
 * a wiring reference is a wiring reference wherever it sits.
 */
function registeredHookFiles(snapshot: HarnessSnapshot): Set<string> {
  const names = new Set<string>();
  for (const text of [
    ...collectStrings(snapshot.settings.parsed),
    ...collectStrings(snapshot.settingsLocal),
  ]) {
    for (const match of text.matchAll(HOOK_PATH)) {
      if (match[1] !== undefined) names.add(match[1]);
    }
  }
  return names;
}

/**
 * `registeredHookFiles` plus every hook file a reachable hook's source
 * mentions by name -- a helper module imported by a registered script is
 * wired in even though no settings command names it. Followed to a
 * fixpoint, so a helper's own helpers count too.
 */
function reachableHookFiles(snapshot: HarnessSnapshot): Set<string> {
  const reachable = registeredHookFiles(snapshot);
  let grew = true;
  while (grew) {
    grew = false;
    for (const name of snapshot.hooks.keys()) {
      if (reachable.has(name)) continue;
      const mentioned = [...reachable].some((other) =>
        snapshot.hooks.get(other)?.includes(name),
      );
      if (mentioned) {
        reachable.add(name);
        grew = true;
      }
    }
  }
  return reachable;
}

/** Translates a Claude Code `paths` glob (`**`, `*`, `?`, `{a,b}`) into a RegExp. */
function globToRegExp(glob: string): RegExp {
  const translate = (source: string): string => {
    let out = "";
    for (let i = 0; i < source.length; i++) {
      const ch = source[i] ?? "";
      if (ch === "*") {
        if (source[i + 1] === "*") {
          i++;
          if (source[i + 1] === "/") {
            i++;
            out += "(?:.*/)?";
          } else {
            out += ".*";
          }
        } else {
          out += "[^/]*";
        }
      } else if (ch === "?") {
        out += "[^/]";
      } else if (ch === "{" && source.indexOf("}", i) !== -1) {
        const close = source.indexOf("}", i);
        out += `(?:${source
          .slice(i + 1, close)
          .split(",")
          .map(translate)
          .join("|")})`;
        i = close;
      } else {
        out += ch.replace(/[.+^$()|[\]\\{}]/g, "\\$&");
      }
    }
    return out;
  };
  return new RegExp(`^${translate(glob)}$`);
}

function bodyLineCount(body: string): number {
  return body.replace(/\n+$/, "").split("\n").length;
}

/** Every rule that reads hook registrations depends on settings.json parsing cleanly -- isolating the parse failure here keeps a downstream rule from either failing confusingly or silently missing every registration. */
const settingsParses: HarnessRule = {
  id: "settings-parses",
  level: "structural",
  category: "settings",
  check: (s) => ({
    checked: s.settings.present ? 1 : 0,
    failures:
      s.settings.error === undefined
        ? []
        : [
            {
              subject: ".claude/settings.json",
              message: `does not parse: ${s.settings.error}`,
            },
          ],
  }),
};

/** settings.local.json can register hooks too, and a downstream rule reading hook registrations needs to know when this file failed to parse rather than silently treating it as absent. */
const settingsLocalParses: HarnessRule = {
  id: "settings-local-parses",
  level: "structural",
  category: "settings",
  check: (s) => ({
    checked: s.settingsLocalError === undefined ? 0 : 1,
    failures:
      s.settingsLocalError === undefined
        ? []
        : [
            {
              subject: ".claude/settings.local.json",
              message: `does not parse: ${s.settingsLocalError}`,
            },
          ],
  }),
};

/** A hook registration naming a file that doesn't exist on disk fails only at the moment Claude Code actually tries to run it -- this is the only check that catches it earlier. */
const hookDangling: HarnessRule = {
  id: "hook-dangling",
  level: "structural",
  category: "hooks",
  check: (s) => {
    // A broken settings.local.json hides its registrations; judging off
    // settings.json alone would misreport them.
    if (s.settings.error !== undefined || s.settingsLocalError !== undefined)
      return { checked: 0, failures: [] };
    const referenced = registeredHookFiles(s);
    return {
      checked: referenced.size,
      failures: [...referenced]
        .filter((name) => !s.hooks.has(name))
        .map((name) => ({
          subject: `.claude/hooks/${name}`,
          message: "is named by a hook registration but does not exist on disk",
        })),
    };
  },
};

/** A hook file that nothing registers and no reachable hook imports is dead code that silently never runs -- easy to leave behind after refactoring settings.json. */
const hookOrphan: HarnessRule = {
  id: "hook-orphan",
  level: "structural",
  category: "hooks",
  check: (s) => {
    // A broken settings.local.json hides its registrations; judging off
    // settings.json alone would misreport them.
    if (s.settings.error !== undefined || s.settingsLocalError !== undefined)
      return { checked: 0, failures: [] };
    const referenced = reachableHookFiles(s);
    const hookFiles = [...s.hooks.keys()].filter(
      (name) => name.endsWith(".mjs") || name.endsWith(".js"),
    );
    return {
      checked: hookFiles.length,
      failures: hookFiles
        .filter((name) => !referenced.has(name))
        .map((name) => ({
          subject: `.claude/hooks/${name}`,
          message:
            "exists but nothing runs it -- no settings.json command names it and no registered hook imports it",
        })),
    };
  },
};

/** The two weaker entry-point comparisons this rule flags both fail open under a symlinked or URL-encoded path -- the hook's own guard against running twice silently stops working exactly when it matters. */
const hookEntrypoint: HarnessRule = {
  id: "hook-entrypoint",
  level: "structural",
  category: "hooks",
  check: (s) => {
    const sources = [...s.hooks].filter(([, source]) =>
      source.includes("process.argv[1]"),
    );
    return {
      checked: sources.length,
      failures: sources
        .filter(
          ([, source]) =>
            BARE_ENTRY_POINT.test(source) ||
            URL_PATHNAME_ENTRY_POINT.test(source) ||
            !source.includes("realpathSync(process.argv[1])"),
        )
        .map(([name]) => ({
          subject: `.claude/hooks/${name}`,
          message:
            "does not compare realpathSync(process.argv[1]) to fileURLToPath(import.meta.url) -- false under a symlinked or URL-encoded path, so the hook fails open",
        })),
    };
  },
};

/** A skill with no SKILL.md, malformed frontmatter, or a `name` that doesn't match its directory won't load the way Claude Code expects -- these are wiring defects, not style choices. */
const skillShape: HarnessRule = {
  id: "skill-shape",
  level: "structural",
  category: "skills",
  check: (s) => {
    const failures: RuleFailure[] = [];
    for (const skill of s.skills) {
      const subject = `.claude/skills/${skill.name}`;
      if (skill.skillMd === undefined) {
        failures.push({ subject, message: "has no SKILL.md" });
        continue;
      }
      const parsed = parseFrontmatter(skill.skillMd);
      if (!parsed.ok) {
        failures.push({ subject, message: `SKILL.md: ${parsed.error}` });
        continue;
      }
      for (const problem of parsed.problems) {
        failures.push({ subject, message: `SKILL.md: ${problem}` });
      }
      // `name` is optional for a skill (it defaults to the directory), so
      // only a name that is present and different is a wiring defect.
      const name = fieldText(parsed.fields, "name");
      if (name !== undefined && name !== "" && name !== skill.name) {
        failures.push({
          subject,
          message: `SKILL.md \`name\` is "${name}" but the directory is "${skill.name}"`,
        });
      }
    }
    return { checked: s.skills.length, failures };
  },
};

/** An agent file needs valid frontmatter with a `name` matching its filename and a `description`, or Claude Code either can't dispatch to it or dispatches under the wrong identity. */
const agentShape: HarnessRule = {
  id: "agent-shape",
  level: "structural",
  category: "agents",
  check: (s) => {
    const failures: RuleFailure[] = [];
    for (const [file, text] of s.agents) {
      const subject = `.claude/agents/${file}`;
      const parsed = parseFrontmatter(text);
      if (!parsed.ok) {
        failures.push({ subject, message: parsed.error });
        continue;
      }
      for (const problem of parsed.problems) {
        failures.push({ subject, message: problem });
      }
      const expected = file.replace(/\.md$/, "");
      const name = fieldText(parsed.fields, "name");
      if (name === undefined || name === "") {
        failures.push({ subject, message: "has no `name`" });
      } else if (name !== expected) {
        failures.push({
          subject,
          message: `\`name\` is "${name}" but the file is "${file}"`,
        });
      }
      const description = fieldText(parsed.fields, "description");
      if (description === undefined || description === "") {
        failures.push({ subject, message: "has no `description`" });
      }
    }
    return { checked: s.agents.size, failures };
  },
};

/** A rule file whose frontmatter fails to parse, or whose `paths` list is empty, silently loads never or loads unconditionally when it was meant to be scoped to specific files. */
const ruleShape: HarnessRule = {
  id: "rule-shape",
  level: "structural",
  category: "rules",
  check: (s) => {
    const failures: RuleFailure[] = [];
    for (const [file, text] of s.rules) {
      const subject = `.claude/rules/${file}`;
      // A rule with no frontmatter at all is a legitimate unconditional rule.
      if (!text.startsWith("---")) continue;
      const parsed = parseFrontmatter(text);
      if (!parsed.ok) {
        failures.push({ subject, message: parsed.error });
        continue;
      }
      for (const problem of parsed.problems) {
        failures.push({ subject, message: problem });
      }
      const paths = fieldList(parsed.fields, "paths");
      if (paths !== undefined && paths.length === 0) {
        failures.push({ subject, message: "declares `paths` but it is empty" });
      }
    }
    return { checked: s.rules.size, failures };
  },
};

/** CLAUDE.md naming a `.claude/` path that doesn't exist misleads whoever reads it next; a rule file CLAUDE.md never mentions is just as easy to forget was ever wired in. */
const claudeMdRefs: HarnessRule = {
  id: "claudemd-refs",
  level: "structural",
  category: "claude-md",
  check: (s) => {
    if (s.claudeMd === undefined) return { checked: 0, failures: [] };
    const failures: RuleFailure[] = [];
    const refs = new Set<string>();
    for (const match of s.claudeMd.matchAll(CLAUDE_PATH)) {
      const path = match[0].replace(/[.,;:]+$/, "").replace(/\/+$/, "");
      if (path.includes("*") || path === ".claude/settings.local.json")
        continue;
      if (path === ".claude") continue;
      refs.add(path);
    }
    for (const path of refs) {
      if (!s.claudeTree.has(path)) {
        failures.push({
          subject: "CLAUDE.md",
          message: `names ${path}, which does not exist`,
        });
      }
    }
    for (const file of s.rules.keys()) {
      if (!s.claudeMd.includes(`.claude/rules/${file}`)) {
        failures.push({
          subject: `.claude/rules/${file}`,
          message: "exists but CLAUDE.md never names it",
        });
      }
    }
    return { checked: refs.size + s.rules.size, failures };
  },
};

/** Anthropic's guidance caps a skill body so loading SKILL.md into context stays cheap -- detail past the limit belongs in references/, not inline. */
const skillBodySize: HarnessRule = {
  id: "skill-body-size",
  level: "rubric",
  category: "skills",
  check: (s) => {
    const failures: RuleFailure[] = [];
    let checked = 0;
    for (const skill of s.skills) {
      if (skill.skillMd === undefined) continue;
      const parsed = parseFrontmatter(skill.skillMd);
      if (!parsed.ok) continue;
      checked++;
      const lines = bodyLineCount(parsed.body);
      if (lines > SKILL_BODY_LINE_LIMIT) {
        failures.push({
          subject: `.claude/skills/${skill.name}`,
          message: `SKILL.md body is ${lines} lines; Anthropic's guidance is <= ${SKILL_BODY_LINE_LIMIT} -- move detail into references/`,
        });
      }
    }
    return { checked, failures };
  },
};

/** A thin or missing description gives Claude nothing reliable to match the skill or agent against -- it either never triggers, or triggers on the wrong request. */
const descriptionSubstance: HarnessRule = {
  id: "description-substance",
  level: "rubric",
  category: "skills",
  check: (s) => {
    const failures: RuleFailure[] = [];
    let checked = 0;
    const examine = (
      subject: string,
      text: string,
      required: boolean,
    ): void => {
      const parsed = parseFrontmatter(text);
      if (!parsed.ok) return;
      const description = fieldText(parsed.fields, "description");
      if (description === undefined || description === "") {
        // Agents require one and shape-check it; a skill may omit it (Claude
        // falls back to the first paragraph), which is a quality gap.
        if (required) return;
        checked++;
        failures.push({
          subject,
          message:
            "has no `description`, so Claude has nothing to match the skill against but its first paragraph",
        });
        return;
      }
      checked++;
      if (description.length < DESCRIPTION_MIN) {
        failures.push({
          subject,
          message: `description is ${description.length} chars -- too thin to trigger on reliably (>= ${DESCRIPTION_MIN})`,
        });
      } else if (description.length > DESCRIPTION_MAX) {
        failures.push({
          subject,
          message: `description is ${description.length} chars; over ${DESCRIPTION_MAX} it is truncated in the skill listing`,
        });
      }
    };
    for (const skill of s.skills) {
      if (skill.skillMd !== undefined) {
        examine(`.claude/skills/${skill.name}`, skill.skillMd, false);
      }
    }
    for (const [file, text] of s.agents) {
      examine(`.claude/agents/${file}`, text, true);
    }
    return { checked, failures };
  },
};

/** An agent that pins no model inherits whatever the calling session happens to run, and a stale model id may reference an alias that's since been retired. */
const modelPinCurrency: HarnessRule = {
  id: "model-pin-currency",
  level: "rubric",
  category: "agents",
  check: (s) => {
    const failures: RuleFailure[] = [];
    let checked = 0;
    for (const [file, text] of s.agents) {
      const parsed = parseFrontmatter(text);
      if (!parsed.ok) continue;
      checked++;
      const model = fieldText(parsed.fields, "model");
      const subject = `.claude/agents/${file}`;
      if (model === undefined || model === "") {
        failures.push({
          subject,
          message: "pins no `model`, so it inherits whatever the session runs",
        });
      } else if (!CURRENT_MODELS.includes(model)) {
        failures.push({
          subject,
          message: `\`model: ${model}\` is not a known-current model id or alias`,
        });
      }
    }
    return { checked, failures };
  },
};

/** An agent that declares no `tools` inherits every tool available, wider access than the agent's actual job usually needs. */
const agentToolScope: HarnessRule = {
  id: "agent-tool-scope",
  level: "rubric",
  category: "agents",
  check: (s) => {
    const failures: RuleFailure[] = [];
    let checked = 0;
    for (const [file, text] of s.agents) {
      const parsed = parseFrontmatter(text);
      if (!parsed.ok) continue;
      checked++;
      if (fieldText(parsed.fields, "tools") === undefined) {
        failures.push({
          subject: `.claude/agents/${file}`,
          message: "declares no `tools`, so it inherits every tool",
        });
      }
    }
    return { checked, failures };
  },
};

/** A hook registration with no `timeout` can hang the whole session indefinitely if the hook itself ever gets stuck. */
const hookTimeout: HarnessRule = {
  id: "hook-timeout",
  level: "rubric",
  category: "hooks",
  check: (s) => {
    const registrations = allRegistrations(s);
    return {
      checked: registrations.length,
      failures: registrations
        .filter((registration) => !registration.hasTimeout)
        .map((registration) => ({
          subject: `${registration.event} hook`,
          message: `\`${registration.command}\` has no \`timeout\``,
        })),
    };
  },
};

/** A rule scoped to a `paths` glob that matches no file in the project silently never loads -- its checklist becomes advice nobody ever sees. */
const ruleGlobsLive: HarnessRule = {
  id: "rule-globs-live",
  level: "rubric",
  category: "rules",
  check: (s) => {
    const failures: RuleFailure[] = [];
    let checked = 0;
    for (const [file, text] of s.rules) {
      const parsed = parseFrontmatter(text);
      if (!parsed.ok) continue;
      for (const glob of fieldList(parsed.fields, "paths") ?? []) {
        checked++;
        const pattern = globToRegExp(glob);
        if (!s.projectFiles.some((path) => pattern.test(path))) {
          failures.push({
            subject: `.claude/rules/${file}`,
            message: `\`paths\` glob "${glob}" matches no file in the project, so the rule never loads`,
          });
        }
      }
    }
    return { checked, failures };
  },
};

/** SKILL.md pointing at a references/ file that doesn't exist promises detail that simply isn't there when someone follows the link. */
const skillReferencesResolve: HarnessRule = {
  id: "skill-references-resolve",
  level: "rubric",
  category: "skills",
  check: (s) => {
    const failures: RuleFailure[] = [];
    let checked = 0;
    for (const skill of s.skills) {
      if (skill.skillMd === undefined) continue;
      const referenced = new Set(
        [...skill.skillMd.matchAll(REFERENCE_PATH)].map((match) => match[0]),
      );
      for (const path of referenced) {
        checked++;
        if (!skill.files.includes(path)) {
          failures.push({
            subject: `.claude/skills/${skill.name}`,
            message: `SKILL.md points at ${path}, which does not exist`,
          });
        }
      }
    }
    return { checked, failures };
  },
};

/** Every rule, structural first. Order is the order findings are reported in. */
export const RULES: readonly HarnessRule[] = [
  settingsParses,
  settingsLocalParses,
  hookDangling,
  hookOrphan,
  hookEntrypoint,
  skillShape,
  agentShape,
  ruleShape,
  claudeMdRefs,
  skillBodySize,
  descriptionSubstance,
  modelPinCurrency,
  agentToolScope,
  hookTimeout,
  ruleGlobsLive,
  skillReferencesResolve,
];
