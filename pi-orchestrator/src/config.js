const { fsp, path, pathExists, resolveMaybeRelative } = require("./utils.js");

const DEFAULT_CONFIG = {
  worktrees: {
    root: null,
    startupHooks: [],
  },
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

function normalizeCommandList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => item && typeof item === "object" && typeof item.command === "string" && item.command.trim())
    .map((item) => ({
      name: String(item.name || item.command),
      command: item.command,
      timeoutSeconds: item.timeoutSeconds,
      required: item.required !== false,
      env: item.env && typeof item.env === "object" ? item.env : undefined,
      runFor: Array.isArray(item.runFor) ? item.runFor.map(String) : undefined,
    }));
}

function defaultWorktreeRoot(repoRoot) {
  return path.resolve(path.dirname(repoRoot), `${path.basename(repoRoot)}-orch-worktrees`);
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
  const workers = { ...(DEFAULT_CONFIG.workers || {}), ...(userConfig.workers || {}) };

  const rootValue = worktrees.root || defaultWorktreeRoot(repoRoot);
  const worktreeRoot = resolveMaybeRelative(repoRoot, rootValue);

  return {
    path: configPath,
    worktrees: {
      root: worktreeRoot,
      rootConfigValue: rootValue,
      startupHooks: normalizeCommandList(worktrees.startupHooks),
    },
    validation: {
      worker: normalizeCommandList(validation.worker),
      integration: normalizeCommandList(validation.integration),
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

module.exports = { DEFAULT_CONFIG, loadConfig, normalizeCommandList };
