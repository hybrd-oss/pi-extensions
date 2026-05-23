const { fsp, path, pathExists, resolveMaybeRelative } = require("./utils.js");

const DEFAULT_CONFIG = {
  worktrees: {
    root: null,
    // Legacy compatibility. Prefer named scripts + explicit selections.
    startupHooks: [],
  },
  scripts: {},
  defaults: {
    workerStartupScripts: [],
    workerValidationScripts: [],
    integrationStartupScripts: [],
    integrationValidationScripts: [],
  },
  // Legacy compatibility. Prefer named scripts + explicit selections.
  validation: {
    worker: [],
    integration: [],
  },
  workers: {
    runner: "pi",
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    allowWorkerDelegation: false,
  },
};

function normalizeScriptIds(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  return value.map(String).filter(Boolean);
}

function normalizeCommandList(list, legacyPrefix = "legacy") {
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => item && typeof item === "object" && typeof item.command === "string" && item.command.trim())
    .map((item, index) => ({
      id: String(item.id || item.name || `${legacyPrefix}:${index}`),
      name: String(item.name || item.id || item.command),
      description: typeof item.description === "string" ? item.description : undefined,
      command: item.command,
      cwd: typeof item.cwd === "string" && item.cwd.trim() ? item.cwd : undefined,
      timeoutSeconds: item.timeoutSeconds,
      required: item.required !== false,
      env: item.env && typeof item.env === "object" ? item.env : undefined,
      runFor: Array.isArray(item.runFor) ? item.runFor.map(String) : undefined,
      legacy: true,
    }));
}

function normalizeScriptsMap(scripts) {
  const normalized = {};
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return normalized;
  for (const [id, value] of Object.entries(scripts)) {
    if (!value || typeof value !== "object" || typeof value.command !== "string" || !value.command.trim()) continue;
    normalized[id] = {
      id,
      name: String(value.name || id),
      description: typeof value.description === "string" ? value.description : undefined,
      command: value.command,
      cwd: typeof value.cwd === "string" && value.cwd.trim() ? value.cwd : undefined,
      timeoutSeconds: value.timeoutSeconds,
      required: value.required !== false,
      env: value.env && typeof value.env === "object" ? value.env : undefined,
      legacy: false,
    };
  }
  return normalized;
}

function defaultWorktreeRoot(repoRoot) {
  return path.resolve(path.dirname(repoRoot), `${path.basename(repoRoot)}-orch-worktrees`);
}

function resolveNamedScripts(config, ids, label) {
  const result = [];
  for (const id of ids || []) {
    const script = config.scripts[id];
    if (!script) {
      const known = Object.keys(config.scripts).sort();
      throw new Error(
        `Unknown orchestrator script id "${id}" in ${label}.` +
          (known.length ? ` Known scripts: ${known.join(", ")}` : " No scripts are defined in .pi/orchestrator/config.json."),
      );
    }
    result.push(script);
  }
  return result;
}

function resolvePhaseScripts(config, selectedIds, defaultIds, legacyCommands, label) {
  const explicit = selectedIds !== undefined;
  const ids = explicit ? normalizeScriptIds(selectedIds) : normalizeScriptIds(defaultIds) || [];
  if (ids.length > 0) return resolveNamedScripts(config, ids, label);

  // Backward compatibility: only fall back to legacy lists when no explicit selection was provided.
  if (!explicit && legacyCommands && legacyCommands.length > 0) return legacyCommands;
  return [];
}

function scriptIds(scripts) {
  return (scripts || []).map((script) => script.id);
}

async function loadConfig(repoRoot) {
  const configPath = path.join(repoRoot, ".pi", "orchestrator", "config.json");
  let userConfig = {};
  if (await pathExists(configPath)) {
    const raw = await fsp.readFile(configPath, "utf8");
    try {
      userConfig = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid orchestrator config JSON at ${configPath}: ${error.message}`);
    }
  }

  const worktrees = { ...(DEFAULT_CONFIG.worktrees || {}), ...(userConfig.worktrees || {}) };
  const validation = { ...(DEFAULT_CONFIG.validation || {}), ...(userConfig.validation || {}) };
  const defaults = { ...(DEFAULT_CONFIG.defaults || {}), ...(userConfig.defaults || {}) };
  const workers = { ...(DEFAULT_CONFIG.workers || {}), ...(userConfig.workers || {}) };

  const rootValue = worktrees.root || defaultWorktreeRoot(repoRoot);
  const worktreeRoot = resolveMaybeRelative(repoRoot, rootValue);

  return {
    path: configPath,
    worktrees: {
      root: worktreeRoot,
      rootConfigValue: rootValue,
      startupHooks: normalizeCommandList(worktrees.startupHooks, "legacy:startup"),
    },
    scripts: normalizeScriptsMap(userConfig.scripts),
    defaults: {
      workerStartupScripts: normalizeScriptIds(defaults.workerStartupScripts) || [],
      workerValidationScripts: normalizeScriptIds(defaults.workerValidationScripts) || [],
      integrationStartupScripts: normalizeScriptIds(defaults.integrationStartupScripts) || [],
      integrationValidationScripts: normalizeScriptIds(defaults.integrationValidationScripts) || [],
    },
    validation: {
      worker: normalizeCommandList(validation.worker, "legacy:worker-validation"),
      integration: normalizeCommandList(validation.integration, "legacy:integration-validation"),
    },
    workers: {
      runner: workers.runner === "mock" ? "mock" : "pi",
      tools: Array.isArray(workers.tools) ? workers.tools.map(String) : DEFAULT_CONFIG.workers.tools,
      model: typeof workers.model === "string" ? workers.model : undefined,
      allowWorkerDelegation: workers.allowWorkerDelegation === true,
      maxConcurrency: Number.isFinite(workers.maxConcurrency) ? Math.max(1, Number(workers.maxConcurrency)) : undefined,
    },
    raw: userConfig,
  };
}

module.exports = {
  DEFAULT_CONFIG,
  loadConfig,
  normalizeCommandList,
  normalizeScriptIds,
  normalizeScriptsMap,
  resolveNamedScripts,
  resolvePhaseScripts,
  scriptIds,
};
