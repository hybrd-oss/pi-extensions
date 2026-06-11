const crypto = require("node:crypto");
const { fsp, os, path, pathExists, slugify } = require("../utils.js");

const SUPPORTED_FRONTMATTER_FIELDS = Object.freeze([
  "name",
  "description",
  "model",
  "thinking",
  "tools",
  "skills",
  "systemPromptMode",
  "inheritProjectContext",
  "maxTurns",
]);

const SYSTEM_PROMPT_MODES = Object.freeze(["append", "replace"]);
const SENSITIVE_PROJECT_RUNTIME_FIELDS = Object.freeze([
  "model",
  "thinking",
  "tools",
  "skills",
  "systemPromptMode",
  "inheritProjectContext",
  "maxTurns",
]);

const SOURCE = Object.freeze({
  BUNDLED: "bundled",
  USER: "user",
  PROJECT: "project",
  LEGACY_PROJECT: "legacy-project",
});

const SOURCE_PRECEDENCE = Object.freeze({
  [SOURCE.BUNDLED]: 10,
  [SOURCE.USER]: 20,
  [SOURCE.LEGACY_PROJECT]: 25,
  [SOURCE.PROJECT]: 30,
});

const PROJECT_SOURCES = new Set([SOURCE.PROJECT, SOURCE.LEGACY_PROJECT]);

function packageRootFromHere() {
  return path.resolve(__dirname, "../..");
}

function normalizeName(value, fallback = "agent") {
  return slugify(value, fallback);
}

function normalizeList(value) {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  const text = String(value).trim();
  if (!text) return [];
  return text.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parseScalar(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((entry) => parseScalar(entry));
  }
  return trimmed;
}

function parseFrontmatterBlock(block) {
  const data = {};
  let currentListKey;
  for (const rawLine of String(block || "").split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "");
    if (!line.trim()) continue;

    const listMatch = /^\s*-\s+(.+)$/.exec(line);
    if (listMatch && currentListKey) {
      if (!Array.isArray(data[currentListKey])) data[currentListKey] = [];
      data[currentListKey].push(parseScalar(listMatch[1]));
      continue;
    }

    const keyMatch = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!keyMatch) continue;
    const key = keyMatch[1];
    const value = keyMatch[2];
    currentListKey = undefined;
    if (value === "") {
      data[key] = [];
      currentListKey = key;
    } else {
      data[key] = parseScalar(value);
    }
  }
  return data;
}

function splitFrontmatter(markdown) {
  const text = String(markdown || "");
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return { frontmatter: {}, body: text };
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { frontmatter: {}, body: text };
  return { frontmatter: parseFrontmatterBlock(match[1]), body: match[2] || "" };
}

function normalizeAgentDefinition(parsed, context = {}) {
  const source = context.source || SOURCE.USER;
  const file = context.file;
  const filename = file ? path.basename(file, path.extname(file)) : "agent";
  const raw = parsed.frontmatter || {};
  const name = normalizeName(raw.name || filename, filename);
  const definition = {
    kind: "pi-multitask-agent-definition",
    id: name,
    name,
    description: raw.description ? String(raw.description) : undefined,
    prompt: String(parsed.body || "").trim(),
    source,
    sourceLabel: source,
    sourcePrecedence: SOURCE_PRECEDENCE[source] || 0,
    file,
    root: context.root,
    relativePath: context.root && file ? path.relative(context.root, file) : undefined,
    supportedFrontmatter: SUPPORTED_FRONTMATTER_FIELDS,
  };

  if (raw.model !== undefined) definition.model = String(raw.model);
  if (raw.thinking !== undefined) definition.thinking = String(raw.thinking);
  if (raw.tools !== undefined) definition.tools = normalizeList(raw.tools);
  if (raw.skills !== undefined) definition.skills = normalizeList(raw.skills);
  if (raw.systemPromptMode !== undefined) {
    const mode = String(raw.systemPromptMode).trim();
    if (!SYSTEM_PROMPT_MODES.includes(mode)) {
      throw new Error(`Unsupported systemPromptMode "${mode}" in agent ${name}. Expected append or replace.`);
    }
    definition.systemPromptMode = mode;
  }
  if (raw.inheritProjectContext !== undefined) definition.inheritProjectContext = Boolean(raw.inheritProjectContext);
  if (raw.maxTurns !== undefined) {
    const maxTurns = Number(raw.maxTurns);
    if (!Number.isFinite(maxTurns) || maxTurns <= 0) {
      throw new Error(`Unsupported maxTurns "${raw.maxTurns}" in agent ${name}. Expected a positive number.`);
    }
    definition.maxTurns = Math.floor(maxTurns);
  }

  const unknownFrontmatter = Object.keys(raw).filter((key) => !SUPPORTED_FRONTMATTER_FIELDS.includes(key));
  if (unknownFrontmatter.length) definition.unknownFrontmatter = unknownFrontmatter;
  definition.hash = hashAgentDefinition(definition);
  return definition;
}

function parseAgentMarkdown(markdown, context = {}) {
  return normalizeAgentDefinition(splitFrontmatter(markdown), context);
}

function hashAgentDefinition(definition) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({
      name: definition.name,
      source: definition.source,
      file: definition.file,
      prompt: definition.prompt,
      description: definition.description,
      model: definition.model,
      thinking: definition.thinking,
      tools: definition.tools,
      skills: definition.skills,
      systemPromptMode: definition.systemPromptMode,
      inheritProjectContext: definition.inheritProjectContext,
      maxTurns: definition.maxTurns,
    }))
    .digest("hex");
}

async function listMarkdownFiles(root) {
  if (!root || !(await pathExists(root))) return [];
  const files = [];
  async function visit(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(full);
    }
  }
  await visit(root);
  return files;
}

function defaultAgentRoots(options = {}) {
  const packageRoot = options.packageRoot || packageRootFromHere();
  const homeDir = options.homeDir || os.homedir();
  const repoRoot = options.repoRoot;
  const roots = [];
  if (options.includeBundledAgents !== false) {
    roots.push({ source: SOURCE.BUNDLED, root: options.bundledAgentsDir || path.join(packageRoot, "agents") });
  }
  if (options.includeUserAgents !== false) {
    roots.push({ source: SOURCE.USER, root: options.userAgentsDir || path.join(homeDir, ".pi", "agent", "agents") });
  }
  if (repoRoot && options.includeProjectAgents !== false) {
    roots.push({ source: SOURCE.PROJECT, root: options.projectAgentsDir || path.join(repoRoot, ".pi", "agents") });
  }
  if (repoRoot && options.includeLegacyProjectAgents !== false) {
    roots.push({ source: SOURCE.LEGACY_PROJECT, root: options.legacyProjectAgentsDir || path.join(repoRoot, ".agents") });
  }
  return roots;
}

async function discoverAgents(options = {}) {
  const roots = options.roots || defaultAgentRoots(options);
  const agents = [];
  const errors = [];
  for (const rootInfo of roots) {
    const root = rootInfo.root;
    const files = await listMarkdownFiles(root).catch((error) => {
      errors.push({ source: rootInfo.source, root, error: error.message });
      return [];
    });
    for (const file of files) {
      try {
        const markdown = await fsp.readFile(file, "utf8");
        agents.push(parseAgentMarkdown(markdown, { ...rootInfo, file, root }));
      } catch (error) {
        errors.push({ source: rootInfo.source, root, file, error: error.message });
      }
    }
  }
  agents.sort(compareAgentsForPrecedence);
  return { agents, errors, roots };
}

function compareAgentsForPrecedence(a, b) {
  const byName = String(a.name).localeCompare(String(b.name));
  if (byName) return byName;
  const byPrecedence = (a.sourcePrecedence || 0) - (b.sourcePrecedence || 0);
  if (byPrecedence) return byPrecedence;
  return String(a.file || "").localeCompare(String(b.file || ""));
}

function compareCandidatesDesc(a, b) {
  const byPrecedence = (b.sourcePrecedence || 0) - (a.sourcePrecedence || 0);
  if (byPrecedence) return byPrecedence;
  return String(b.file || "").localeCompare(String(a.file || ""));
}

function isProjectAgent(definition) {
  return PROJECT_SOURCES.has(definition?.source);
}

function trustedProjectAgentMatches(entry, agent) {
  if (!entry) return false;
  if (typeof entry === "string") {
    return entry === agent.name || entry === agent.id || entry === agent.file || entry === agent.hash;
  }
  if (typeof entry !== "object") return false;
  if (entry.name && normalizeName(entry.name) !== agent.name) return false;
  if (entry.source && entry.source !== agent.source) return false;
  if (entry.file && path.resolve(entry.file) !== path.resolve(agent.file || "")) return false;
  if (entry.hash && entry.hash !== agent.hash) return false;
  return Boolean(entry.name || entry.file || entry.hash || entry.source);
}

function isExplicitlyTrustedProjectAgent(agent, options = {}) {
  if (options.allowProjectAgents === true || options.trustProjectAgents === true || options.projectAgentTrust === "allow") return true;
  const trusted = options.trustedProjectAgents || options.approvedProjectAgents || [];
  return Array.isArray(trusted) && trusted.some((entry) => trustedProjectAgentMatches(entry, agent));
}

async function evaluateProjectAgentTrust(agent, options = {}) {
  if (!isProjectAgent(agent)) return { trusted: true, reason: "not_project_local" };
  if (isExplicitlyTrustedProjectAgent(agent, options)) {
    return { trusted: true, reason: "explicit_project_agent_opt_in" };
  }
  if (options.projectAgentTrust === "block" || options.allowProjectAgents === false) {
    return { trusted: false, reason: "project_agents_blocked" };
  }
  if (options.interactive === true && typeof options.confirmProjectAgent === "function") {
    const decision = await options.confirmProjectAgent(agent, {
      sensitiveRuntimeFields: projectRuntimeFieldsPresent(agent),
    });
    if (decision === true) return { trusted: true, reason: "interactive_confirmation" };
    if (decision && typeof decision === "object" && decision.approved === true) {
      return {
        trusted: true,
        reason: "interactive_confirmation",
        allowProjectRuntimeControls: decision.allowRuntimeControls === true || decision.allowProjectRuntimeControls === true,
      };
    }
    return { trusted: false, reason: "interactive_confirmation_declined" };
  }
  if (options.interactive === true) return { trusted: false, reason: "interactive_confirmation_required" };
  return { trusted: false, reason: "non_interactive_project_agent_opt_in_required" };
}

function projectRuntimeFieldsPresent(agent) {
  return SENSITIVE_PROJECT_RUNTIME_FIELDS.filter((field) => agent?.[field] !== undefined);
}

function copyAgentConfig(agent) {
  const config = {};
  for (const field of SUPPORTED_FRONTMATTER_FIELDS) {
    if (agent[field] !== undefined) config[field] = Array.isArray(agent[field]) ? [...agent[field]] : agent[field];
  }
  config.name = agent.name;
  if (agent.prompt !== undefined) config.prompt = agent.prompt;
  return config;
}

function applyProjectRuntimeControlPolicy(agent, baseAgent, options = {}, trust = {}) {
  const effectiveConfig = copyAgentConfig(agent);
  const warnings = [];
  const ignoredFields = [];
  const allowRuntimeControls = options.allowProjectRuntimeControls === true || trust.allowProjectRuntimeControls === true;
  if (isProjectAgent(agent) && !allowRuntimeControls) {
    for (const field of projectRuntimeFieldsPresent(agent)) {
      ignoredFields.push(field);
      if (baseAgent && baseAgent[field] !== undefined) {
        effectiveConfig[field] = Array.isArray(baseAgent[field]) ? [...baseAgent[field]] : baseAgent[field];
      } else {
        delete effectiveConfig[field];
      }
    }
    if (ignoredFields.length) {
      warnings.push(`Ignored project-local runtime control(s) for agent ${agent.name}: ${ignoredFields.join(", ")}. Pass allowProjectRuntimeControls to opt in explicitly.`);
    }
  }
  return {
    effectiveConfig,
    warnings,
    security: {
      source: agent.source,
      isProjectLocal: isProjectAgent(agent),
      projectRuntimeControlsAllowed: allowRuntimeControls,
      sensitiveRuntimeFields: projectRuntimeFieldsPresent(agent),
      sensitiveRuntimeFieldsIgnored: ignoredFields,
    },
  };
}

function createUntrustedProjectAgentError(agent, trust, fallbackAgent) {
  const location = agent.file ? ` at ${agent.file}` : "";
  const error = new Error(`Project-local multitask agent "${agent.name}"${location} is not trusted (${trust.reason}). Confirm it interactively or pass allowProjectAgents/trustedProjectAgents explicitly.`);
  error.code = "PI_MULTITASK_PROJECT_AGENT_UNTRUSTED";
  error.agent = agent;
  error.trust = trust;
  error.fallbackAgent = fallbackAgent;
  return error;
}

async function resolveAgent(name = "worker", options = {}) {
  const requested = normalizeName(name || "worker", "worker");
  const discovery = options.discovery || await discoverAgents(options);
  const candidates = (discovery.agents || [])
    .filter((agent) => agent.name === requested || agent.id === requested)
    .sort(compareCandidatesDesc);
  if (!candidates.length) {
    const error = new Error(`No multitask agent definition found for "${name}".`);
    error.code = "PI_MULTITASK_AGENT_NOT_FOUND";
    error.discovery = discovery;
    throw error;
  }

  const selected = candidates[0];
  const fallbackAgent = candidates.find((agent) => !isProjectAgent(agent));
  let trust = { trusted: true, reason: "not_project_local" };
  if (isProjectAgent(selected)) {
    trust = await evaluateProjectAgentTrust(selected, options);
    if (!trust.trusted) {
      if (options.onUntrustedProjectAgent === "fallback" && fallbackAgent) {
        return finalizeResolvedAgent(fallbackAgent, {
          discovery,
          candidates,
          fallbackFrom: selected,
          warnings: [`Skipped untrusted project-local agent ${selected.name} from ${selected.file || selected.source}; using ${fallbackAgent.source} definition instead.`],
        }, options, { trusted: true, reason: "fallback_after_untrusted_project_agent" });
      }
      throw createUntrustedProjectAgentError(selected, trust, fallbackAgent);
    }
  }
  return finalizeResolvedAgent(selected, { discovery, candidates, baseAgent: fallbackAgent }, options, trust);
}

function finalizeResolvedAgent(agent, context, options, trust) {
  const baseAgent = context.baseAgent && context.baseAgent !== agent ? context.baseAgent : undefined;
  const policy = applyProjectRuntimeControlPolicy(agent, baseAgent, options, trust);
  return {
    kind: "pi-multitask-agent-resolution",
    name: agent.name,
    agent,
    config: policy.effectiveConfig,
    source: agent.source,
    file: agent.file,
    trust,
    security: policy.security,
    candidates: context.candidates || [],
    discovery: context.discovery,
    warnings: [...(context.warnings || []), ...policy.warnings],
    fallbackFrom: context.fallbackFrom,
  };
}

function formatAgentPromptAddition(resolutionOrAgent, context = {}) {
  const resolution = resolutionOrAgent?.kind === "pi-multitask-agent-resolution" ? resolutionOrAgent : undefined;
  const agent = resolution ? resolution.agent : resolutionOrAgent;
  const config = resolution ? resolution.config : copyAgentConfig(agent);
  const lines = [
    `# Porchestrator Agent Role: ${config.name || agent.name}`,
    "",
  ];
  if (config.description) lines.push(config.description, "");
  if (context.manifest || context.task) {
    lines.push("## Porchestrator Assignment", "");
    if (context.manifest?.runId) lines.push(`- Run: ${context.manifest.runId}`);
    if (context.task?.id) lines.push(`- Task: ${context.task.id}`);
    if (context.task?.branch) lines.push(`- Branch: ${context.task.branch}`);
    if (context.task?.worktree) lines.push(`- Worktree: ${context.task.worktree}`);
    lines.push("");
  }
  if (config.prompt) lines.push(config.prompt.trim(), "");
  if (resolution?.warnings?.length) {
    lines.push("## Agent Registry Notes", "");
    for (const warning of resolution.warnings) lines.push(`- ${warning}`);
    lines.push("");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function agentConfigToWorkerLaunchMetadata(resolutionOrAgent, context = {}) {
  const resolution = resolutionOrAgent?.kind === "pi-multitask-agent-resolution" ? resolutionOrAgent : finalizeResolvedAgent(resolutionOrAgent, {}, {}, { trusted: true, reason: "direct_agent" });
  const config = resolution.config;
  const promptAddition = formatAgentPromptAddition(resolution, context);
  const launchOptions = {
    agent: config.name,
    model: config.model,
    thinking: config.thinking,
    tools: config.tools,
    skills: config.skills,
    systemPromptMode: config.systemPromptMode || "append",
    inheritProjectContext: config.inheritProjectContext,
    maxTurns: config.maxTurns,
    appendSystemPrompt: promptAddition,
  };
  return {
    kind: "pi-multitask-agent-worker-launch-metadata",
    agent: {
      name: resolution.agent.name,
      source: resolution.agent.source,
      file: resolution.agent.file,
      description: resolution.agent.description,
      hash: resolution.agent.hash,
    },
    launchOptions,
    promptAddition,
    warnings: resolution.warnings || [],
    security: resolution.security,
  };
}

async function resolveAgentForTask(task = {}, options = {}) {
  const resolution = await resolveAgent(task.agent || "worker", options);
  return {
    ...resolution,
    workerLaunchMetadata: agentConfigToWorkerLaunchMetadata(resolution, {
      manifest: options.manifest,
      task,
    }),
  };
}

async function loadAgentRegistry(options = {}) {
  return discoverAgents(options);
}

async function listAgents(options = {}) {
  const discovery = await discoverAgents(options);
  return discovery.agents;
}

module.exports = {
  PROJECT_SOURCES: [...PROJECT_SOURCES],
  SENSITIVE_PROJECT_RUNTIME_FIELDS,
  SOURCE,
  SOURCE_PRECEDENCE,
  SUPPORTED_FRONTMATTER_FIELDS,
  SYSTEM_PROMPT_MODES,
  agentConfigToWorkerLaunchMetadata,
  defaultAgentRoots,
  discoverAgents,
  evaluateProjectAgentTrust,
  formatAgentPromptAddition,
  isProjectAgent,
  parseAgentMarkdown,
  listAgents,
  loadAgentRegistry,
  resolveAgent,
  resolveAgentForTask,
  resolveTaskAgent: resolveAgentForTask,
  createAgentWorkerLaunchMetadata: agentConfigToWorkerLaunchMetadata,
};
