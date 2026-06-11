const { getRepoInfo } = require("../git.js");
const { slugify } = require("../utils.js");
const { cleanupMultitaskRun, collectCleanupTargets, summarizeCleanupResult } = require("./cleanup.js");
const { cleanupStaleDaemonFiles, getDaemonStatus } = require("./lifecycle.js");
const { listRuns, loadManifest } = require("./manifest.js");
const { TERMINAL_RUN_STATUSES } = require("./contracts.js");

const PRUNE_SCHEMA_VERSION = 1;

function normalizeRunIds(input = {}) {
  const ids = [];
  if (input.runId) ids.push(input.runId);
  if (Array.isArray(input.runIds)) ids.push(...input.runIds);
  return [...new Set(ids.map((id) => slugify(id, "run")))];
}

function timestampOlderThanDays(value, days, now = new Date()) {
  if (!Number.isFinite(days) || days <= 0) return true;
  if (!value) return false;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return false;
  return now.getTime() - time >= days * 24 * 60 * 60 * 1000;
}

function selectPruneRuns(runs = [], input = {}, options = {}) {
  const explicitIds = normalizeRunIds(input);
  const explicit = explicitIds.length > 0;
  const terminalOnly = input.terminalOnly !== false && input.all !== true && !explicit;
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const olderThanDays = input.olderThanDays === undefined ? undefined : Number(input.olderThanDays);
  const terminal = new Set(TERMINAL_RUN_STATUSES || ["merged", "failed", "aborted"]);

  const selected = [];
  for (const run of runs) {
    if (explicit && !explicitIds.includes(slugify(run.runId, "run"))) continue;
    if (terminalOnly && !terminal.has(run.status)) continue;
    if (olderThanDays !== undefined && !timestampOlderThanDays(run.updatedAt || run.createdAt, olderThanDays, now)) continue;
    selected.push(run);
  }
  const found = new Set(selected.map((run) => slugify(run.runId, "run")));
  const missing = explicitIds.filter((id) => !found.has(id));
  return { selected, missing, explicitIds };
}

function requiredConfirmationPhrase(runIds = [], extra = {}) {
  if (runIds.length === 1) return `delete ${runIds[0]}`;
  if (runIds.length > 1) return `delete ${runIds.length} Porchestrator runs`;
  if (Number(extra.daemonTargetCount || 0) > 0) return "delete daemon metadata";
  return "delete 0 Porchestrator runs";
}

function hasDeleteConfirmation(input = {}, runIds = [], extra = {}) {
  const targetCount = runIds.length + Number(extra.daemonTargetCount || 0);
  if (!targetCount) return false;
  if (input.force === true) return true;
  const phrase = requiredConfirmationPhrase(runIds, extra);
  return input.confirm === phrase || input.confirmation === phrase;
}

function flattenTargetsForSummary(result = {}) {
  return (result.runs || []).flatMap((run) => [
    ...(run.worktrees || []).map((target) => ({ runId: run.runId, ...target })),
    ...(run.state || []).map((target) => ({ runId: run.runId, ...target })),
  ]);
}

function summarizePruneResult(result = {}) {
  const lines = [`# Porchestrator Prune`, ""];
  if (result.dryRun) lines.push("Dry run only; no files were removed.", "");
  if (result.requiresConfirmation) {
    lines.push(`Deletion was requested but not performed. To delete these targets, rerun with confirm: ${result.requiredConfirmation}`);
    lines.push("");
  }
  if (result.missingRunIds?.length) lines.push(`Missing run ids: ${result.missingRunIds.join(", ")}`, "");
  if (!result.runs?.length) lines.push("No Porchestrator runs matched the prune selection.");
  for (const run of result.runs || []) {
    lines.push(`## ${run.runId}`);
    const all = [...(run.worktrees || []), ...(run.state || [])];
    if (!all.length) lines.push("- no cleanup targets selected");
    for (const entry of all) {
      lines.push(`- ${entry.status || "planned"} ${entry.type} ${entry.id || ""} ${entry.path}${entry.reason ? ` — ${entry.reason}` : ""}`.trim());
    }
    lines.push("");
  }
  if (result.daemon) {
    lines.push("## Daemon metadata");
    for (const target of result.daemon.targets || []) {
      lines.push(`- ${target.status || "planned"} ${target.type} ${target.path}${target.reason ? ` — ${target.reason}` : ""}`);
    }
    if (!result.daemon.targets?.length) lines.push("- no stale daemon metadata selected");
  }
  const targetCount = flattenTargetsForSummary(result).length + (result.daemon?.targets?.length || 0);
  lines.push("", `Selected ${result.runs?.length || 0} run(s), ${targetCount} target(s).`);
  return lines.join("\n").trim();
}

async function collectPrunePlan(input = {}, options = {}) {
  const repo = options.repo || await getRepoInfo(options.cwd || process.cwd());
  let runs;
  const explicitIds = normalizeRunIds(input);
  if (options.runs) {
    runs = options.runs;
  } else if (explicitIds.length === 1 && input.loadOnly === true) {
    runs = [await loadManifest(repo.root, explicitIds[0])];
  } else {
    runs = await (options.listRuns || listRuns)(repo.root);
  }
  const selection = selectPruneRuns(runs, input, options);
  const runPlans = selection.selected.map((manifest) => {
    const targets = collectCleanupTargets(manifest, {
      removeWorktrees: input.removeWorktrees,
      removeState: input.removeState,
    });
    return {
      runId: manifest.runId,
      status: manifest.status,
      updatedAt: manifest.updatedAt,
      manifest,
      worktrees: targets.worktrees.map((target) => ({ ...target, status: "planned" })),
      state: targets.state.map((target) => ({ ...target, status: "planned" })),
    };
  });

  let daemon;
  if (input.includeDaemon === true || input.daemon === true) {
    const status = await (options.getDaemonStatus || getDaemonStatus)(repo.root, options.daemonOptions || options).catch((error) => ({ error: error.message }));
    const targets = [];
    if (status.staleSocket && status.socketPath) targets.push({ type: "daemon-socket", path: status.socketPath, status: "planned" });
    if (status.stalePid && status.pidPath) targets.push({ type: "daemon-pid", path: status.pidPath, status: "planned" });
    daemon = { status, targets };
  }

  const runIds = runPlans.map((run) => run.runId);
  const daemonTargetCount = daemon?.targets?.length || 0;
  const confirmed = hasDeleteConfirmation(input, runIds, { daemonTargetCount });
  const deletionRequested = input.dryRun === false;
  const dryRun = !deletionRequested || !confirmed;
  const plan = {
    kind: "pi-multitask-prune-plan",
    schemaVersion: PRUNE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    repoRoot: repo.root,
    dryRun,
    deletionRequested,
    confirmed,
    requiresConfirmation: deletionRequested && !confirmed && (runIds.length + daemonTargetCount) > 0,
    requiredConfirmation: requiredConfirmationPhrase(runIds, { daemonTargetCount }),
    missingRunIds: selection.missing,
    runs: runPlans,
    daemon,
  };
  plan.summary = summarizePruneResult(plan);
  return plan;
}

async function pruneMultitask(input = {}, options = {}) {
  const plan = await collectPrunePlan(input, options);
  if (plan.dryRun) return plan;

  const repo = options.repo || { root: plan.repoRoot };
  const runs = [];
  for (const runPlan of plan.runs) {
    const result = await cleanupMultitaskRun({
      runId: runPlan.runId,
      removeWorktrees: input.removeWorktrees,
      removeState: input.removeState,
      dryRun: false,
      force: input.force,
      gitWorktreeRemove: input.gitWorktreeRemove,
      fallbackRemove: input.fallbackRemove,
      timeoutSeconds: input.timeoutSeconds,
    }, { ...options, repo, manifest: runPlan.manifest });
    runs.push({ ...runPlan, worktrees: result.worktrees, state: result.state, cleanupSummary: summarizeCleanupResult(result) });
  }

  let daemon = plan.daemon;
  if (daemon?.targets?.length) {
    const cleanup = await (options.cleanupStaleDaemonFiles || cleanupStaleDaemonFiles)(repo.root, options.daemonOptions || options).catch((error) => ({ error: error.message, removed: [], skipped: [] }));
    const removed = new Set((cleanup.removed || []).map((entry) => entry.path));
    const skippedByPath = new Map((cleanup.skipped || []).map((entry) => [entry.path, entry]));
    daemon = {
      ...daemon,
      cleanup,
      targets: daemon.targets.map((target) => removed.has(target.path)
        ? { ...target, status: "removed" }
        : { ...target, status: "skipped", reason: skippedByPath.get(target.path)?.reason || cleanup.error }),
    };
  }

  const result = {
    ...plan,
    dryRun: false,
    runs,
    daemon,
  };
  result.summary = summarizePruneResult(result);
  return result;
}

module.exports = {
  PRUNE_SCHEMA_VERSION,
  collectPrunePlan,
  hasDeleteConfirmation,
  pruneMultitask,
  requiredConfirmationPhrase,
  selectPruneRuns,
  summarizePruneResult,
};
