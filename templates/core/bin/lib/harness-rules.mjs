/**
 * Grades this project's Claude Code harness (`.claude/` plus `CLAUDE.md`).
 * `gradeHarness` reads everything once into a snapshot, then runs each rule
 * over it. Structural rules catch wiring defects -- a hook registration that
 * points at nothing, a skill with no frontmatter -- and fail the gate.
 * Rubric rules encode Anthropic's published guidance and only ever warn.
 *
 * Also used by m3l-groundwork's own adopt mode (the tool that generated this
 * project's harness); if you're contributing a change back upstream, keep
 * this file's behavior in sync with its source at
 * `packages/cli/src/harness/{rules,grade}.ts` there.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fieldList, fieldText, parseFrontmatter } from "./frontmatter.mjs";

/**
 * Model ids and aliases considered current. Bump alongside a harness-guidance
 * refresh sweep.
 * @public Not imported anywhere else in this project -- exported only for
 * m3l-groundwork's own upstream parity check (see the file header above).
 */
export const CURRENT_MODELS = [
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
const PROJECT_WALK_DEPTH = 8;
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
const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".pnpm",
  "out",
  ".nx",
]);

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// --- reading the project ---------------------------------------------------

/** Bounded recursive listing: skips dependency/build dirs, stops at `maxDepth`. */
function walkBounded(root, maxDepth) {
  const results = [];
  const visit = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && SKIP_DIR_NAMES.has(entry.name)) continue;
      const path = join(dir, entry.name);
      results.push({
        path,
        relPath: relative(root, path).split("\\").join("/"),
        isDirectory: entry.isDirectory(),
      });
      if (entry.isDirectory()) visit(path, depth + 1);
    }
  };
  visit(root, 0);
  return results;
}

/** Strips `//` and block comments and trailing commas, leaving string literals alone. */
function stripJsoncNoise(content) {
  let result = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1];
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        result += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      result += ch;
      if (ch === "\\") {
        result += next ?? "";
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    result += ch;
  }
  return result.replace(/,(\s*[}\]])/g, "$1");
}

function readJsonc(path) {
  if (!existsSync(path)) return { ok: false, error: `${path} does not exist` };
  try {
    return {
      ok: true,
      value: JSON.parse(stripJsoncNoise(readFileSync(path, "utf8"))),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function loadSnapshot(root) {
  const entries = walkBounded(root, PROJECT_WALK_DEPTH);
  const claudeEntries = entries.filter((entry) =>
    entry.relPath.startsWith(".claude/"),
  );

  const readEach = (pattern, strip) =>
    new Map(
      claudeEntries
        .filter((entry) => !entry.isDirectory && pattern.test(entry.relPath))
        .map((entry) => [
          entry.relPath.slice(strip.length),
          readText(entry.path) ?? "",
        ]),
    );

  const skills = claudeEntries
    .filter(
      (entry) =>
        entry.isDirectory && /^\.claude\/skills\/[^/]+$/.test(entry.relPath),
    )
    .map((dir) => {
      const prefix = `${dir.relPath}/`;
      const files = claudeEntries
        .filter(
          (entry) => !entry.isDirectory && entry.relPath.startsWith(prefix),
        )
        .map((entry) => entry.relPath.slice(prefix.length));
      return {
        name: dir.relPath.slice(".claude/skills/".length),
        skillMd: files.includes("SKILL.md")
          ? readText(join(dir.path, "SKILL.md"))
          : undefined,
        files,
      };
    });

  const settingsPath = join(root, ".claude", "settings.json");
  const settingsResult = readJsonc(settingsPath);
  const settingsLocalPath = join(root, ".claude", "settings.local.json");
  const settingsLocalResult = readJsonc(settingsLocalPath);

  return {
    settings: !existsSync(settingsPath)
      ? { present: false, error: undefined, parsed: undefined }
      : settingsResult.ok
        ? { present: true, error: undefined, parsed: settingsResult.value }
        : { present: true, error: settingsResult.error, parsed: undefined },
    settingsLocal: settingsLocalResult.ok
      ? settingsLocalResult.value
      : undefined,
    // Only a file that exists can fail to parse -- an absent one is not an error.
    settingsLocalError:
      !settingsLocalResult.ok && existsSync(settingsLocalPath)
        ? settingsLocalResult.error
        : undefined,
    hooks: readEach(/^\.claude\/hooks\/[^/]+$/, ".claude/hooks/"),
    agents: readEach(/^\.claude\/agents\/[^/]+\.md$/, ".claude/agents/"),
    skills,
    rules: readEach(/^\.claude\/rules\/[^/]+\.md$/, ".claude/rules/"),
    claudeMd: readText(join(root, "CLAUDE.md")),
    claudeTree: new Set(claudeEntries.map((entry) => entry.relPath)),
    projectFiles: entries
      .filter((entry) => !entry.isDirectory)
      .map((entry) => entry.relPath),
  };
}

// --- helpers ---------------------------------------------------------------

function hookRegistrations(settings) {
  if (!isRecord(settings) || !isRecord(settings["hooks"])) return [];
  const registrations = [];
  for (const [event, entries] of Object.entries(settings["hooks"])) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isRecord(entry) || !Array.isArray(entry["hooks"])) continue;
      for (const hook of entry["hooks"]) {
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

function allRegistrations(snapshot) {
  return [
    ...hookRegistrations(snapshot.settings.parsed),
    ...hookRegistrations(snapshot.settingsLocal),
  ];
}

/** Every string anywhere inside a parsed JSON value. */
function collectStrings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (isRecord(value)) return Object.values(value).flatMap(collectStrings);
  return [];
}

/**
 * Hook files named by any command in settings -- `hooks` registrations and
 * also top-level command keys such as `statusLine` -- named directly, since
 * a wiring reference is a wiring reference wherever it sits.
 */
function registeredHookFiles(snapshot) {
  const names = new Set();
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
function reachableHookFiles(snapshot) {
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
function globToRegExp(glob) {
  const translate = (source) => {
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

function bodyLineCount(body) {
  return body.replace(/\n+$/, "").split("\n").length;
}

// --- rules -----------------------------------------------------------------

/** Every rule that reads hook registrations depends on settings.json parsing cleanly -- isolating the parse failure here keeps a downstream rule from either failing confusingly or silently missing every registration. */
const settingsParses = {
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
const settingsLocalParses = {
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
const hookDangling = {
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
const hookOrphan = {
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
const hookEntrypoint = {
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
const skillShape = {
  id: "skill-shape",
  level: "structural",
  category: "skills",
  check: (s) => {
    const failures = [];
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
const agentShape = {
  id: "agent-shape",
  level: "structural",
  category: "agents",
  check: (s) => {
    const failures = [];
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
const ruleShape = {
  id: "rule-shape",
  level: "structural",
  category: "rules",
  check: (s) => {
    const failures = [];
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
const claudeMdRefs = {
  id: "claudemd-refs",
  level: "structural",
  category: "claude-md",
  check: (s) => {
    if (s.claudeMd === undefined) return { checked: 0, failures: [] };
    const failures = [];
    const refs = new Set();
    for (const match of s.claudeMd.matchAll(CLAUDE_PATH)) {
      const path = match[0].replace(/[.,;:]+$/, "").replace(/\/+$/, "");
      if (path.includes("*") || path === ".claude/settings.local.json") {
        continue;
      }
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
const skillBodySize = {
  id: "skill-body-size",
  level: "rubric",
  category: "skills",
  check: (s) => {
    const failures = [];
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
const descriptionSubstance = {
  id: "description-substance",
  level: "rubric",
  category: "skills",
  check: (s) => {
    const failures = [];
    let checked = 0;
    const examine = (subject, text, required) => {
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
const modelPinCurrency = {
  id: "model-pin-currency",
  level: "rubric",
  category: "agents",
  check: (s) => {
    const failures = [];
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
const agentToolScope = {
  id: "agent-tool-scope",
  level: "rubric",
  category: "agents",
  check: (s) => {
    const failures = [];
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
const hookTimeout = {
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
const ruleGlobsLive = {
  id: "rule-globs-live",
  level: "rubric",
  category: "rules",
  check: (s) => {
    const failures = [];
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
const skillReferencesResolve = {
  id: "skill-references-resolve",
  level: "rubric",
  category: "skills",
  check: (s) => {
    const failures = [];
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

/**
 * Every rule, structural first. Order is the order findings are reported in.
 * @public Not imported anywhere else in this project -- exported only for
 * m3l-groundwork's own upstream parity check (see the file header above).
 */
export const RULES = [
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

const CATEGORIES = [
  "settings",
  "hooks",
  "skills",
  "agents",
  "rules",
  "claude-md",
];

/**
 * Feeds a grade to a `createReporter()` reporter: structural findings fail,
 * rubric findings warn, and a summary line closes the run. Kept here rather
 * than in each gate script so the repo's own wrapper and the emitted gate
 * cannot report the same grade differently.
 * @param {ReturnType<typeof gradeHarness>} grade
 * @param {{ ok: (m: string) => void, warn: (m: string) => void, fail: (m: string) => void }} reporter
 */
export function reportGrade(grade, reporter) {
  for (const finding of grade.findings) {
    const line = `[${finding.ruleId}] ${finding.subject} -- ${finding.message}`;
    if (finding.level === "structural") {
      reporter.fail(line);
    } else {
      reporter.warn(line);
    }
  }
  const { checked, failed } = grade.structural;
  if (failed === 0) {
    reporter.ok(`harness wiring: ${checked} structural checks passed`);
  }
  const rubricChecked = Object.values(grade.rubric).reduce(
    (sum, tally) => sum + tally.checked,
    0,
  );
  reporter.ok(
    `harness rubric: ${(grade.rubricScore * 100).toFixed(0)}% over ${rubricChecked} checks (warnings never fail the gate)`,
  );
}

/**
 * Runs Anthropic's own `claude plugin validate --strict` over the skills and
 * agents directories and relays what it reports. Its rules are Anthropic's,
 * not ours, so they track the CLI without a hand-maintained list -- but they
 * also change with the CLI version, so every finding is a warning and never
 * fails the gate. Skipped quietly when the `claude` CLI is not installed
 * (CI, a fresh machine).
 * @param {string} rootDir
 * @param {{ ok: (m: string) => void, warn: (m: string) => void }} reporter
 */
export function reportOfficialValidation(rootDir, reporter) {
  let ran = false;
  let findings = 0;
  let unreadable = 0;
  for (const dir of [".claude/skills", ".claude/agents"]) {
    const target = join(rootDir, dir);
    if (!existsSync(target)) continue;
    const result = spawnSync(
      "claude",
      ["plugin", "validate", "--strict", "--json", target],
      { encoding: "utf8", timeout: 30_000 },
    );
    if (result.error?.code === "ENOENT") {
      reporter.ok("claude CLI not found -- skipped Anthropic's own validator");
      return;
    }
    let report;
    try {
      report = JSON.parse(result.stdout);
    } catch {
      report = undefined;
    }
    // Anything other than a real report -- a spawn failure other than
    // ENOENT (result.stdout is then null, and JSON.parse(null) parses as
    // the value `null` rather than throwing), or a valid-JSON error payload
    // with no `contents` array -- is treated the same as unreadable, never
    // silently read as "zero findings" or allowed to crash on `.contents`.
    if (!Array.isArray(report?.contents)) {
      reporter.warn(
        `claude plugin validate gave no readable report for ${dir}`,
      );
      unreadable++;
      continue;
    }
    ran = true;
    // Each entry and finding is external data too: a malformed one is
    // reported and skipped, never allowed to crash the gate or vanish.
    for (const entry of report.contents) {
      if (!isRecord(entry) || typeof entry.file !== "string") {
        reporter.warn(
          `claude plugin validate reported a malformed entry for ${dir} -- skipped`,
        );
        unreadable++;
        continue;
      }
      const errors = Array.isArray(entry.errors) ? entry.errors : [];
      const warnings = Array.isArray(entry.warnings) ? entry.warnings : [];
      const file = relative(rootDir, entry.file);
      for (const item of [...errors, ...warnings]) {
        findings++;
        if (!isRecord(item)) {
          reporter.warn(
            `[claude-validate] ${file} -- malformed finding (not an object)`,
          );
          continue;
        }
        reporter.warn(
          `[claude-validate] ${file} -- ${String(item.path)}: ${String(item.message)}`,
        );
      }
    }
  }
  if (ran && findings === 0 && unreadable === 0) {
    reporter.ok("claude plugin validate: no findings");
  }
}

/**
 * Runs every rule over the harness rooted at `rootDir`.
 * @param {string} rootDir
 */
export function gradeHarness(rootDir) {
  const snapshot = loadSnapshot(rootDir);
  const findings = [];
  const structural = { checked: 0, failed: 0 };
  const rubric = Object.fromEntries(
    CATEGORIES.map((category) => [category, { checked: 0, failed: 0 }]),
  );

  for (const rule of RULES) {
    const result = rule.check(snapshot);
    const tally =
      rule.level === "structural" ? structural : rubric[rule.category];
    tally.checked += result.checked;
    tally.failed += result.failures.length;
    for (const failure of result.failures) {
      findings.push({
        ruleId: rule.id,
        level: rule.level,
        category: rule.category,
        subject: failure.subject,
        message: failure.message,
      });
    }
  }

  const rubricChecked = Object.values(rubric).reduce(
    (sum, tally) => sum + tally.checked,
    0,
  );
  const rubricFailed = Object.values(rubric).reduce(
    (sum, tally) => sum + tally.failed,
    0,
  );
  return {
    findings,
    structural,
    rubric,
    rubricScore: rubricChecked === 0 ? 1 : 1 - rubricFailed / rubricChecked,
  };
}
