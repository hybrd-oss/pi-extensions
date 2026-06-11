const { loadConfig } = require("../config.js");
const { getRepoInfo, git } = require("../git.js");
const { fs, fsp, path, pathExists, runCommand, slugify } = require("../utils.js");
const { analyzeRunRecovery, formatRecoverySuggestions } = require("./recovery.js");
const { formatDaemonStatus, getDaemonStatus } = require("./lifecycle.js");
const {
  listRuns,
  multitaskConfigPath,
  multitaskRoot,
  runsRoot,
} = require("./manifest.js");

const DOCTOR_STATUS = Object.freeze({
  PASS: "pass",
  WARN: "warn",
  FAIL: "fail",
  INFO: "info",
});

const CHECK_ORDER = Object.freeze([
  "git-state",
  "foreground-checkout",
  "pi-rpc",
  "daemon-socket",
  "stale-pids",
  "worktree-root",
  "config-scripts",
  "permissions",
  "worker-recovery",
]);

function makeCheck(id, title, status, summary, extra = {}) {
  return {
    id,
    title,
    status,
    summary,
    details: extra.details,
    recovery: Array.isArray(extra.recovery) ? extra.recovery.filter(Boolean) : [],
    data: extra.data,
  };
}

function aggregateStatus(checks) {
  if ((checks || []).some((check) => check.status === DOCTOR_STATUS.FAIL)) return DOCTOR_STATUS.FAIL;
  if ((checks || []).some((check) => check.status === DOCTOR_STATUS.WARN)) return DOCTOR_STATUS.WARN;
  return DOCTOR_STATUS.PASS;
}

function sortChecks(checks) {
  const order = new Map(CHECK_ORDER.map((id, index) => [id, index]));
  return [...checks].sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function accessOk(target, mode) {
  try {
    await fsp.access(target, mode);
    return true;
  } catch (error) {
    return false;
  }
}

async function statSafe(target) {
  try {
    return await fsp.stat(target);
  } catch (error) {
    return undefined;
  }
}

async function nearestExistingParent(target) {
  let current = path.resolve(target);
  while (!(await pathExists(current))) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function pathIsInside(parent, child) {
  if (!parent || !child) return false;
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function resolveDoctorContext(input = {}, options = {}) {
  const cwd = options.cwd || input.cwd || process.cwd();
  let repo = options.repo;
  let repoError;
  if (!repo) {
    try {
      repo = await (options.getRepoInfo || getRepoInfo)(cwd);
    } catch (error) {
      repoError = error;
    }
  }

  let config;
  let configError;
  if (repo?.root) {
    try {
      config = options.config || await (options.loadConfig || loadConfig)(repo.root);
    } catch (error) {
      configError = error;
    }
  }

  return { cwd, repo, repoError, config, configError };
}

async function runGit(repoRoot, args, options = {}) {
  if (typeof options.runGit === "function") return options.runGit(repoRoot, args, options);
  return git(repoRoot, args, { allowFailure: true, timeoutSeconds: options.timeoutSeconds || 30 });
}

async function checkGitState(context, options = {}) {
  if (!context.repo?.root) {
    return makeCheck(
      "git-state",
      "Git repository",
      DOCTOR_STATUS.FAIL,
      "Current directory is not a readable git worktree.",
      {
        details: context.repoError?.message,
        recovery: ["Run multitask commands from inside the foreground repository checkout."],
      },
    );
  }

  const repoRoot = context.repo.root;
  const inside = await runGit(repoRoot, ["rev-parse", "--is-inside-work-tree"], options);
  const worktrees = await runGit(repoRoot, ["worktree", "list", "--porcelain"], options);
  const details = {
    repoRoot,
    branch: context.repo.branch,
    baseCommit: context.repo.baseCommit,
    isInsideWorkTree: inside.stdout.trim(),
    worktreeListAvailable: worktrees.exitCode === 0,
  };

  if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
    return makeCheck(
      "git-state",
      "Git repository",
      DOCTOR_STATUS.FAIL,
      "Git does not consider the foreground checkout a worktree.",
      {
        details: { ...details, stderr: inside.stderr },
        recovery: ["Repair the checkout or run /mt-doctor from a valid git worktree."],
      },
    );
  }

  if (worktrees.exitCode !== 0) {
    return makeCheck(
      "git-state",
      "Git repository",
      DOCTOR_STATUS.WARN,
      "Git is usable, but `git worktree list` failed.",
      {
        details: { ...details, stderr: worktrees.stderr },
        recovery: ["Run `git worktree list --porcelain` manually and repair stale worktree metadata if needed."],
      },
    );
  }

  return makeCheck(
    "git-state",
    "Git repository",
    DOCTOR_STATUS.PASS,
    `Foreground checkout is a git worktree at ${repoRoot}.`,
    { details },
  );
}

async function checkForegroundCleanliness(context, options = {}) {
  if (!context.repo?.root) {
    return makeCheck(
      "foreground-checkout",
      "Foreground checkout cleanliness",
      DOCTOR_STATUS.FAIL,
      "Cannot check checkout cleanliness without a git repository.",
      { recovery: ["Run from a valid repository checkout."] },
    );
  }
  const status = await runGit(context.repo.root, ["status", "--porcelain", "--untracked-files=all"], options);
  if (status.exitCode !== 0) {
    return makeCheck(
      "foreground-checkout",
      "Foreground checkout cleanliness",
      DOCTOR_STATUS.FAIL,
      "Unable to inspect foreground checkout status.",
      { details: status.stderr || status.stdout, recovery: ["Run `git status` and fix repository errors before applying multitask results."] },
    );
  }
  const dirty = status.stdout.trim();
  if (dirty) {
    return makeCheck(
      "foreground-checkout",
      "Foreground checkout cleanliness",
      DOCTOR_STATUS.WARN,
      "Foreground checkout has uncommitted or untracked changes.",
      {
        details: dirty,
        recovery: [
          "Commit, stash, or discard foreground changes before running multitask_apply.",
          "Worker worktrees remain isolated, but apply/merge back to the foreground checkout is intentionally guarded.",
        ],
      },
    );
  }
  return makeCheck(
    "foreground-checkout",
    "Foreground checkout cleanliness",
    DOCTOR_STATUS.PASS,
    "Foreground checkout is clean for safe apply operations.",
  );
}

async function checkPiRpc(context, options = {}) {
  if (context.configError) {
    return makeCheck(
      "pi-rpc",
      "Pi RPC availability",
      DOCTOR_STATUS.FAIL,
      "Cannot check Pi RPC because Porchestrator config failed to load.",
      { details: context.configError.message, recovery: ["Fix .pi/multitask/config.json and rerun /mt-doctor."] },
    );
  }
  const runner = context.config?.workers?.runner || "pi";
  if (runner === "mock") {
    return makeCheck(
      "pi-rpc",
      "Pi RPC availability",
      DOCTOR_STATUS.PASS,
      "Worker runner is configured as mock; no Pi RPC process is required for this run.",
      { data: { runner } },
    );
  }

  const command = runner || "pi";
  const checker = options.runCommand || runCommand;
  const result = await checker("sh", ["-lc", `command -v ${shellQuote(command)}`], {
    cwd: context.repo?.root || context.cwd,
    timeoutSeconds: 5,
  });
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return makeCheck(
      "pi-rpc",
      "Pi RPC availability",
      DOCTOR_STATUS.FAIL,
      `Pi RPC command ${command} was not found on PATH.`,
      {
        details: result.stderr || result.stdout,
        recovery: [
          "Install Pi and ensure the `pi` executable is on PATH for the daemon process.",
          "For no-credit tests only, set multitask workers.runner to `mock` in .pi/multitask/config.json.",
        ],
        data: { runner: command },
      },
    );
  }

  return makeCheck(
    "pi-rpc",
    "Pi RPC availability",
    DOCTOR_STATUS.PASS,
    `Pi RPC command is available: ${result.stdout.trim()}.`,
    { data: { runner: command, commandPath: result.stdout.trim() } },
  );
}

async function checkDaemon(context, options = {}) {
  if (!context.repo?.root) {
    return makeCheck("daemon-socket", "Daemon socket", DOCTOR_STATUS.FAIL, "Cannot inspect daemon socket without a repository root.");
  }
  let status;
  try {
    status = options.daemonStatus || await (options.getDaemonStatus || getDaemonStatus)(context.repo.root, options.daemonOptions || options);
  } catch (error) {
    return makeCheck("daemon-socket", "Daemon socket", DOCTOR_STATUS.FAIL, "Unable to inspect daemon socket metadata.", {
      details: error.message,
      recovery: ["Check .pi/multitask daemon pid/socket paths and filesystem permissions."],
    });
  }
  let checkStatus = DOCTOR_STATUS.PASS;
  const recovery = [];
  if (status.status === "stale") {
    checkStatus = DOCTOR_STATUS.WARN;
    recovery.push("Run /mt-prune with daemon cleanup enabled or remove stale daemon pid/socket files after confirming no daemon is alive.");
  } else if (status.status === "degraded") {
    checkStatus = DOCTOR_STATUS.WARN;
    recovery.push("Restart the multitask daemon; a pid exists but the socket is not reachable.");
  }
  if (status.status === "stopped") {
    recovery.push("Start a multitask run or daemon before sending live worker messages. Export, doctor, and prune can run offline.");
  }
  return makeCheck(
    "daemon-socket",
    "Daemon socket",
    checkStatus,
    formatDaemonStatus(status),
    { details: status, recovery, data: status },
  );
}

async function checkStalePids(context, options = {}) {
  if (!context.repo?.root) return makeCheck("stale-pids", "Stale daemon pid files", DOCTOR_STATUS.FAIL, "Cannot inspect pid file without a repository root.");
  let status;
  try {
    status = options.daemonStatus || await (options.getDaemonStatus || getDaemonStatus)(context.repo.root, options.daemonOptions || options);
  } catch (error) {
    return makeCheck("stale-pids", "Stale daemon pid files", DOCTOR_STATUS.FAIL, "Unable to inspect daemon pid/socket files.", {
      details: error.message,
      recovery: ["Check .pi/multitask daemon pid/socket paths and filesystem permissions."],
    });
  }
  if (status.stalePid || status.staleSocket) {
    return makeCheck(
      "stale-pids",
      "Stale daemon pid files",
      DOCTOR_STATUS.WARN,
      "Stale daemon metadata was found.",
      {
        details: status,
        recovery: [
          `Inspect ${status.pidPath} and ${status.socketPath}.`,
          "If no daemon is alive, remove stale files with lifecycle cleanup or /mt-prune daemon cleanup.",
        ],
      },
    );
  }
  return makeCheck(
    "stale-pids",
    "Stale daemon pid files",
    DOCTOR_STATUS.PASS,
    status.pidPathExists ? "Daemon pid metadata points at a live process." : "No stale daemon pid file found.",
    { details: status },
  );
}

async function checkWorktreeRoot(context) {
  if (!context.repo?.root) return makeCheck("worktree-root", "Worker worktree root", DOCTOR_STATUS.FAIL, "Cannot resolve worker worktree root without a repository root.");
  if (context.configError) {
    return makeCheck("worktree-root", "Worker worktree root", DOCTOR_STATUS.FAIL, "Cannot resolve worker worktree root because config failed to load.", {
      details: context.configError.message,
      recovery: ["Fix .pi/multitask/config.json."],
    });
  }
  const root = context.config?.worktrees?.root;
  const details = { worktreeRoot: root, configuredValue: context.config?.worktrees?.rootConfigValue };
  if (!root || !path.isAbsolute(root)) {
    return makeCheck("worktree-root", "Worker worktree root", DOCTOR_STATUS.FAIL, "Worker worktree root is not an absolute path.", {
      details,
      recovery: ["Set multitask.worktrees.root to an absolute path or a repo-relative path in .pi/multitask/config.json."],
    });
  }
  const rootStat = await statSafe(root);
  if (rootStat && !rootStat.isDirectory()) {
    return makeCheck("worktree-root", "Worker worktree root", DOCTOR_STATUS.FAIL, "Configured worker worktree root exists but is not a directory.", {
      details,
      recovery: [`Move or remove ${root}, then rerun multitask provisioning.`],
    });
  }
  const parent = rootStat ? root : await nearestExistingParent(path.dirname(root));
  const writable = await accessOk(parent, fs.constants.W_OK);
  const warnings = [];
  if (path.resolve(root) === path.resolve(context.repo.root) || pathIsInside(context.repo.root, root)) {
    warnings.push("worker worktree root is inside the foreground checkout");
  }
  if (!writable) {
    return makeCheck("worktree-root", "Worker worktree root", DOCTOR_STATUS.FAIL, `Worker worktree root parent is not writable: ${parent}.`, {
      details,
      recovery: ["Choose a writable worktree root or fix directory permissions."],
    });
  }
  if (warnings.length) {
    return makeCheck("worktree-root", "Worker worktree root", DOCTOR_STATUS.WARN, `Worker worktree root is usable, but ${warnings.join(" and ")}.`, {
      details,
      recovery: ["Prefer a worktree root outside the foreground checkout to avoid accidental edits and noisy git status."],
    });
  }
  return makeCheck("worktree-root", "Worker worktree root", DOCTOR_STATUS.PASS, rootStat ? `Worker worktree root exists and is writable: ${root}.` : `Worker worktree root can be created: ${root}.`, { details });
}

function collectConfiguredScriptIds(config) {
  const ids = [];
  for (const key of [
    "workerStartupScripts",
    "workerValidationScripts",
    "integrationStartupScripts",
    "integrationValidationScripts",
  ]) {
    for (const id of config?.defaults?.[key] || []) ids.push({ id, source: `defaults.${key}` });
  }
  return ids;
}

async function checkConfigScripts(context) {
  if (!context.repo?.root) return makeCheck("config-scripts", "Config scripts", DOCTOR_STATUS.FAIL, "Cannot inspect config scripts without a repository root.");
  const configPath = multitaskConfigPath(context.repo.root);
  if (context.configError) {
    return makeCheck("config-scripts", "Config scripts", DOCTOR_STATUS.FAIL, "Porchestrator config could not be parsed.", {
      details: { configPath, error: context.configError.message },
      recovery: ["Fix JSON syntax and script definitions in .pi/multitask/config.json."],
    });
  }
  const exists = await pathExists(configPath);
  const invalidScripts = [];
  const missingDefaultScripts = [];
  const missingCwds = [];
  const rawScripts = context.config?.raw?.scripts || {};
  if (context.config?.raw?.scripts && (typeof rawScripts !== "object" || Array.isArray(rawScripts))) {
    invalidScripts.push("scripts must be an object map");
  } else if (rawScripts && typeof rawScripts === "object") {
    for (const [id, value] of Object.entries(rawScripts)) {
      if (!value || typeof value !== "object" || typeof value.command !== "string" || !value.command.trim()) {
        invalidScripts.push(id);
      }
    }
  }
  for (const entry of collectConfiguredScriptIds(context.config)) {
    if (!context.config.scripts[entry.id]) missingDefaultScripts.push(entry);
  }
  for (const script of Object.values(context.config?.scripts || {})) {
    if (script.cwd) {
      const cwd = path.isAbsolute(script.cwd) ? script.cwd : path.resolve(context.repo.root, script.cwd);
      if (!(await pathExists(cwd))) missingCwds.push({ id: script.id, cwd });
    }
  }
  const details = {
    configPath,
    configExists: exists,
    scripts: Object.keys(context.config?.scripts || {}).sort(),
    defaults: context.config?.defaults,
    invalidScripts,
    missingDefaultScripts,
    missingCwds,
  };
  if (invalidScripts.length || missingDefaultScripts.length) {
    return makeCheck("config-scripts", "Config scripts", DOCTOR_STATUS.FAIL, "Porchestrator config has invalid or unresolved script references.", {
      details,
      recovery: [
        "Ensure every script has a non-empty command string.",
        "Ensure default startup/validation script ids exist under scripts in .pi/multitask/config.json.",
      ],
    });
  }
  if (missingCwds.length) {
    return makeCheck("config-scripts", "Config scripts", DOCTOR_STATUS.WARN, "Some configured script working directories do not exist.", {
      details,
      recovery: ["Create the missing script cwd directories or update script.cwd paths."],
    });
  }
  return makeCheck(
    "config-scripts",
    "Config scripts",
    DOCTOR_STATUS.PASS,
    exists ? "Porchestrator config scripts and defaults are resolvable." : "No Porchestrator config file found; defaults are safe and no scripts are configured.",
    { details },
  );
}

async function checkPermissions(context) {
  if (!context.repo?.root) return makeCheck("permissions", "State directory permissions", DOCTOR_STATUS.FAIL, "Cannot inspect permissions without a repository root.");
  const root = multitaskRoot(context.repo.root);
  const runs = runsRoot(context.repo.root);
  const configPath = multitaskConfigPath(context.repo.root);
  const targets = [root, runs, path.dirname(configPath)].filter(Boolean);
  const details = [];
  const failures = [];
  for (const target of [...new Set(targets)]) {
    const exists = await pathExists(target);
    const checkTarget = exists ? target : await nearestExistingParent(path.dirname(target));
    const readable = exists ? await accessOk(target, fs.constants.R_OK) : undefined;
    const writable = await accessOk(checkTarget, fs.constants.W_OK);
    const entry = { path: target, exists, checkTarget, readable, writable };
    details.push(entry);
    if (exists && !readable) failures.push(`${target} is not readable`);
    if (!writable) failures.push(`${checkTarget} is not writable`);
  }
  if (failures.length) {
    return makeCheck("permissions", "State directory permissions", DOCTOR_STATUS.FAIL, "Porchestrator state directories are not readable/writable.", {
      details,
      recovery: ["Fix filesystem permissions for .pi/multitask and its parent directories.", ...failures],
    });
  }
  return makeCheck("permissions", "State directory permissions", DOCTOR_STATUS.PASS, "Porchestrator state directories are readable/writable or can be created.", { details });
}

async function checkWorkerRecovery(context, options = {}) {
  if (!context.repo?.root) return makeCheck("worker-recovery", "Worker recovery state", DOCTOR_STATUS.FAIL, "Cannot inspect worker recovery without a repository root.");
  const runs = options.runs || await (options.listRuns || listRuns)(context.repo.root).catch(() => []);
  const selectedRunId = options.runId || options.input?.runId;
  const selected = selectedRunId
    ? runs.filter((run) => run.runId === slugify(selectedRunId, "run") || run.runId === selectedRunId)
    : runs;
  const reports = [];
  for (const manifest of selected) {
    reports.push(await (options.analyzeRunRecovery || analyzeRunRecovery)(manifest, {
      repoRoot: context.repo.root,
      workerSessions: options.workerSessions || new Map(),
    }));
  }
  const lost = reports.flatMap((report) => report.lostRunningTasks || report.staleRunningTasks || []);
  const details = { runCount: selected.length, reports: reports.map((report) => ({ runId: report.runId, summary: report.summary, lostRunningTasks: report.lostRunningTasks?.length || 0 })) };
  if (lost.length) {
    return makeCheck("worker-recovery", "Worker recovery state", DOCTOR_STATUS.WARN, `${lost.length} task(s) are marked running without a live daemon worker handle.`, {
      details,
      recovery: reports.map((report) => formatRecoverySuggestions(report)).filter(Boolean),
    });
  }
  return makeCheck("worker-recovery", "Worker recovery state", DOCTOR_STATUS.PASS, selected.length ? "No stale running workers were detected in persisted run state." : "No persisted Porchestrator runs found.", { details });
}

async function runDoctor(input = {}, options = {}) {
  const context = await resolveDoctorContext(input, options);
  const daemonStatus = context.repo?.root ? await (options.getDaemonStatus || getDaemonStatus)(context.repo.root, options.daemonOptions || options).catch(() => undefined) : undefined;
  const checkOptions = { ...options, input, daemonStatus };
  const checks = sortChecks([
    await checkGitState(context, checkOptions),
    await checkForegroundCleanliness(context, checkOptions),
    await checkPiRpc(context, checkOptions),
    await checkDaemon(context, checkOptions),
    await checkStalePids(context, checkOptions),
    await checkWorktreeRoot(context, checkOptions),
    await checkConfigScripts(context, checkOptions),
    await checkPermissions(context, checkOptions),
    await checkWorkerRecovery(context, checkOptions),
  ]);
  const report = {
    kind: "pi-multitask-doctor-report",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repoRoot: context.repo?.root,
    runId: input.runId,
    status: aggregateStatus(checks),
    checks,
  };
  report.summary = summarizeDoctorReport(report);
  return report;
}

function summarizeDoctorReport(report = {}) {
  const counts = { pass: 0, warn: 0, fail: 0, info: 0 };
  for (const check of report.checks || []) counts[check.status] = (counts[check.status] || 0) + 1;
  return `Porchestrator doctor: ${report.status || aggregateStatus(report.checks || [])} (${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail).`;
}

function formatDoctorReport(report = {}) {
  const lines = [
    "# Porchestrator Doctor",
    "",
    `Overall: ${report.status || aggregateStatus(report.checks || [])}`,
    report.repoRoot ? `Repository: ${report.repoRoot}` : undefined,
    report.runId ? `Run: ${report.runId}` : undefined,
    "",
  ].filter(Boolean);
  for (const check of report.checks || []) {
    lines.push(`- [${check.status}] ${check.title}: ${check.summary}`);
    for (const recovery of check.recovery || []) {
      for (const line of String(recovery).split(/\r?\n/).filter(Boolean)) {
        lines.push(`  recovery: ${line}`);
      }
    }
  }
  lines.push("", report.summary || summarizeDoctorReport(report));
  return lines.join("\n");
}

module.exports = {
  DOCTOR_STATUS,
  aggregateStatus,
  checkConfigScripts,
  checkDaemon,
  checkForegroundCleanliness,
  checkGitState,
  checkPermissions,
  checkPiRpc,
  checkStalePids,
  checkWorkerRecovery,
  checkWorktreeRoot,
  formatDoctorReport,
  runDoctor,
  summarizeDoctorReport,
};
