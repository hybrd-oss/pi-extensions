const { fsp, path, pathExists, resolveMaybeRelative } = require("./utils.js");

const DEFAULT_CONFIG = {
  worktrees: {
    root: null,
  },
  scripts: {},
  defaults: {
    workerStartupScripts: [],
    workerValidationScripts: [],
    integrationStartupScripts: [],
    integrationValidationScripts: [],
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
    };
  }
  return normalized;
}

function defaultWorktreeRoot(repoRoot) {
  return path.resolve(path.dirname(repoRoot), `${path.basename(repoRoot)}-multitask-worktrees`);
}

function resolveNamedScripts(config, ids, label) {
  const result = [];
  for (const id of ids || []) {
    const script = config.scripts[id];
    if (!script) {
      const known = Object.keys(config.scripts).sort();
      throw new Error(
        `Unknown multitask script id "${id}" in ${label}.` +
          (known.length ? ` Known scripts: ${known.join(", ")}` : " No scripts are defined in .pi/multitask/config.json."),
      );
    }
    result.push(script);
  }
  return result;
}

function resolvePhaseScripts(config, selectedIds, defaultIds, label) {
  const explicit = selectedIds !== undefined;
  const ids = explicit ? normalizeScriptIds(selectedIds) : normalizeScriptIds(defaultIds) || [];
  return ids.length > 0 ? resolveNamedScripts(config, ids, label) : [];
}

function scriptIds(scripts) {
  return (scripts || []).map((script) => script.id);
}

async function loadConfig(repoRoot) {
  const configPath = path.join(repoRoot, ".pi", "multitask", "config.json");
  let userConfig = {};
  if (await pathExists(configPath)) {
    const raw = await fsp.readFile(configPath, "utf8");
    try {
      userConfig = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid multitask config JSON at ${configPath}: ${error.message}`);
    }
  }

  const worktrees = { ...(DEFAULT_CONFIG.worktrees || {}), ...(userConfig.worktrees || {}) };
  const defaults = { ...(DEFAULT_CONFIG.defaults || {}), ...(userConfig.defaults || {}) };
  const workers = { ...(DEFAULT_CONFIG.workers || {}), ...(userConfig.workers || {}) };

  const rootValue = worktrees.root || defaultWorktreeRoot(repoRoot);
  const worktreeRoot = resolveMaybeRelative(repoRoot, rootValue);

  return {
    path: configPath,
    worktrees: {
      root: worktreeRoot,
      rootConfigValue: rootValue,
    },
    scripts: normalizeScriptsMap(userConfig.scripts),
    defaults: {
      workerStartupScripts: normalizeScriptIds(defaults.workerStartupScripts) || [],
      workerValidationScripts: normalizeScriptIds(defaults.workerValidationScripts) || [],
      integrationStartupScripts: normalizeScriptIds(defaults.integrationStartupScripts) || [],
      integrationValidationScripts: normalizeScriptIds(defaults.integrationValidationScripts) || [],
    },
    validation: {
      worker: [],
      integration: [],
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
  normalizeScriptIds,
  normalizeScriptsMap,
  resolveNamedScripts,
  resolvePhaseScripts,
  scriptIds,
};
