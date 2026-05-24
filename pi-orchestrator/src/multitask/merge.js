const { loadConfig, resolvePhaseScripts, scriptIds } = require("../config.js");
const {
  addAndCommit,
  branchExists,
  createWorktree,
  getCurrentCommit,
  getRepoInfo,
  git,
  isDirty,
} = require("../git.js");
const { runStartupScripts, runValidationScripts } = require("../hooks.js");
const { ensureDir, path, pathExists, slugify } = require("../utils.js");
const { appendRunEvent, appendTaskEvent } = require("./events.js");
const {
  branchFor,
  loadManifest,
  runDir,
  saveManifest,
  saveTaskState,
  worktreePathFor,
} = require("./manifest.js");

function namedManifestScriptSelection(config, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return undefined;
  return ids.every((id) => config.scripts[id]) ? ids : undefined;
}

function resolveIntegrationScriptsForMerge(config, manifest, input = {}) {
  return {
    startup: resolvePhaseScripts(
      config,
      input.startupScripts !== undefined ? input.startupScripts : namedManifestScriptSelection(config, manifest.integration?.startupScripts),
      config.defaults.integrationStartupScripts,
      "multitask integration startupScripts",
    ),
    validation: resolvePhaseScripts(
      config,
      input.validationScripts !== undefined ? input.validationScripts : namedManifestScriptSelection(config, manifest.integration?.validationScripts),
      config.defaults.integrationValidationScripts,
      "multitask integration validationScripts",
    ),
  };
}

function ensureIntegrationRecord(manifest, config) {
  if (!manifest.integration) {
    manifest.integration = {
      id: "integration",
      status: "planned",
      branch: branchFor(manifest.runId, "integration"),
      worktree: worktreePathFor(config.worktrees.root, manifest.runId, "integration"),
      startupScripts: [],
      validationScripts: [],
      startupResults: [],
      validation: [],
    };
  }
  if (!manifest.integration.id) manifest.integration.id = "integration";
  return manifest.integration;
}

function selectTask(manifest, taskId) {
  const normalized = slugify(taskId, "task");
  const task = (manifest.tasks || []).find((candidate) => candidate.id === normalized || candidate.id === taskId);
  if (!task) throw new Error(`No multitask task ${taskId} in run ${manifest.runId}.`);
  return task;
}

function selectMergeTasks(manifest, taskIds) {
  if (Array.isArray(taskIds) && taskIds.length > 0) return taskIds.map((taskId) => selectTask(manifest, taskId));
  return (manifest.tasks || []).filter((task) => task.status === "ready_to_merge");
}

async function addExistingBranchWorktree(repoRoot, worktree, branch) {
  return git(repoRoot, ["worktree", "add", worktree, branch], { timeoutSeconds: 180 });
}

async function ensureIntegrationWorktree(repoRoot, config, manifest, input = {}) {
  const integration = ensureIntegrationRecord(manifest, config);
  const scripts = resolveIntegrationScriptsForMerge(config, manifest, input);
  integration.startupScripts = scriptIds(scripts.startup);
  integration.validationScripts = scriptIds(scripts.validation);

  if (integration.worktree && await pathExists(integration.worktree)) {
    return { integration, scripts, created: false };
  }

  integration.status = "creating_worktree";
  integration.updatedAt = new Date().toISOString();
  await saveManifest(repoRoot, manifest);
  await appendRunEvent(repoRoot, manifest.runId, "integration_status_changed", { status: integration.status });

  await ensureDir(path.dirname(integration.worktree));
  const baseRef = input.baseRef || manifest.baseRef || manifest.baseCommit || "HEAD";
  if (integration.branch && await branchExists(repoRoot, integration.branch)) {
    await addExistingBranchWorktree(repoRoot, integration.worktree, integration.branch);
  } else {
    await createWorktree(repoRoot, integration.worktree, integration.branch, baseRef, input.worktreeOptions || {});
  }

  integration.status = "setup";
  integration.startupResults = await runStartupScripts(config, integration.worktree, "integration", {
    runId: manifest.runId,
    runDir: runDir(repoRoot, manifest.runId),
    taskId: "integration",
  }, scripts.startup);
  integration.status = "idle";
  integration.updatedAt = new Date().toISOString();
  await saveManifest(repoRoot, manifest);
  await appendRunEvent(repoRoot, manifest.runId, "integration_worktree_ready", {
    branch: integration.branch,
    worktree: integration.worktree,
  });
  return { integration, scripts, created: true };
}

async function ensureTaskBranchReady(repoRoot, manifest, task) {
  if (!task.branch) throw new Error(`Task ${task.id} has no branch to merge.`);
  if (task.worktree && await pathExists(task.worktree)) {
    const result = await addAndCommit(task.worktree, ["-A"], `multitask: complete ${manifest.runId}/${task.id}`);
    task.commit = result.commit;
    task.lastMergePreparation = {
      committed: result.committed,
      commit: result.commit,
      completedAt: new Date().toISOString(),
    };
    await saveTaskState(repoRoot, manifest.runId, task);
    await saveManifest(repoRoot, manifest);
    await appendTaskEvent(repoRoot, manifest.runId, task.id, "task_merge_prepared", task.lastMergePreparation);
  }
  if (!(await branchExists(repoRoot, task.branch))) throw new Error(`Task branch does not exist for ${task.id}: ${task.branch}`);
  return task.branch;
}

async function mergeBranchIntoIntegration(integration, task) {
  return git(integration.worktree, ["merge", "--no-ff", task.branch, "-m", `multitask: merge ${task.id}`], {
    allowFailure: true,
    timeoutSeconds: 300,
  });
}

function validationFailed(results) {
  return (results || []).some((result) => result?.status === "failed" && result.required !== false);
}

function summarizeMergeResult(runId, merges, integration) {
  const lines = [`# Multitask Merge: ${runId}`, ""];
  if (!merges.length) lines.push("No ready tasks were selected for merge.");
  for (const merge of merges) {
    lines.push(`- ${merge.taskId}: ${merge.status}${merge.commit ? ` @ ${String(merge.commit).slice(0, 12)}` : ""}`);
    if (merge.stderr && merge.status !== "merged") lines.push(`  stderr: ${merge.stderr.trim()}`);
  }
  if (integration) {
    lines.push("", `Integration: ${integration.status}`);
    if (integration.branch) lines.push(`Branch: ${integration.branch}`);
    if (integration.worktree) lines.push(`Worktree: ${integration.worktree}`);
    if (integration.commit) lines.push(`Commit: ${integration.commit}`);
  }
  return lines.join("\n");
}

async function mergeTasks(input = {}, options = {}) {
  if (!input.runId) throw new Error("runId is required for multitask merge.");
  const repo = options.repo || await getRepoInfo(options.cwd || process.cwd());
  const config = options.config || await loadConfig(repo.root);
  const manifest = options.manifest || await loadManifest(repo.root, slugify(input.runId, "run"));
  const selectedTasks = selectMergeTasks(manifest, input.taskIds);
  const merges = [];

  if (!selectedTasks.length) {
    return { runId: manifest.runId, manifest, integration: manifest.integration, merges, summary: summarizeMergeResult(manifest.runId, merges, manifest.integration) };
  }
  for (const task of selectedTasks) {
    if (task.status !== "ready_to_merge") {
      throw new Error(`Task ${task.id} is ${task.status}; only ready_to_merge tasks can be merged.`);
    }
  }

  const { integration, scripts } = await ensureIntegrationWorktree(repo.root, config, manifest, input);

  manifest.status = "merging";
  integration.status = "merging";
  integration.merges = integration.merges || [];
  integration.updatedAt = new Date().toISOString();
  await saveManifest(repo.root, manifest);
  await appendRunEvent(repo.root, manifest.runId, "integration_merge_started", { taskIds: selectedTasks.map((task) => task.id) });

  for (const task of selectedTasks) {
    const existing = integration.merges.find((entry) => entry.taskId === task.id && entry.status === "merged");
    if (existing) {
      merges.push({ ...existing, skipped: true });
      continue;
    }

    await ensureTaskBranchReady(repo.root, manifest, task);
    const result = await mergeBranchIntoIntegration(integration, task);
    const entry = {
      taskId: task.id,
      branch: task.branch,
      commit: task.commit,
      status: result.exitCode === 0 ? "merged" : "conflict",
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      completedAt: new Date().toISOString(),
    };
    integration.merges.push(entry);
    merges.push(entry);
    if (result.exitCode !== 0) {
      integration.status = "needs_attention";
      manifest.status = "needs_attention";
      integration.updatedAt = new Date().toISOString();
      await saveManifest(repo.root, manifest);
      await appendRunEvent(repo.root, manifest.runId, "integration_merge_conflict", entry);
      return { runId: manifest.runId, manifest, integration, merges, conflict: entry, summary: summarizeMergeResult(manifest.runId, merges, integration) };
    }

    task.status = "merged";
    task.mergedAt = entry.completedAt;
    await saveTaskState(repo.root, manifest.runId, task);
    await saveManifest(repo.root, manifest);
    await appendTaskEvent(repo.root, manifest.runId, task.id, "task_merged_to_integration", entry);
  }

  integration.validation = await runValidationScripts(config, integration.worktree, "integration", {
    runId: manifest.runId,
    runDir: runDir(repo.root, manifest.runId),
    taskId: "integration",
  }, scripts.validation).catch((error) => {
    integration.validationError = error.message;
    return error.results || [error.commandResult].filter(Boolean);
  });

  integration.commit = await getCurrentCommit(integration.worktree).catch(() => undefined);
  integration.status = validationFailed(integration.validation) ? "validation_failed" : "ready";
  integration.updatedAt = new Date().toISOString();
  manifest.status = integration.status === "validation_failed" ? "needs_attention" : "merged";
  await saveManifest(repo.root, manifest);
  await appendRunEvent(repo.root, manifest.runId, "integration_merge_completed", {
    status: integration.status,
    commit: integration.commit,
    taskIds: merges.map((merge) => merge.taskId),
  });

  return { runId: manifest.runId, manifest, integration, merges, summary: summarizeMergeResult(manifest.runId, merges, integration) };
}

async function requireCleanForegroundCheckout(repoRoot) {
  if (!(await isDirty(repoRoot))) return;
  const status = await git(repoRoot, ["status", "--porcelain", "--untracked-files=all"], { allowFailure: true });
  const error = new Error([
    "Foreground checkout has uncommitted or untracked changes. Commit, stash, or pass requireClean:false before multitask_apply.",
    status.stdout.trim(),
  ].filter(Boolean).join("\n"));
  error.status = status.stdout;
  throw error;
}

function summarizeApplyResult(runId, apply) {
  const lines = [`# Multitask Apply: ${runId}`, "", `Status: ${apply.status}`];
  if (apply.branch) lines.push(`Branch: ${apply.branch}`);
  if (apply.commit) lines.push(`Commit: ${apply.commit}`);
  if (apply.stderr && apply.status !== "applied") lines.push("", apply.stderr.trim());
  return lines.join("\n");
}

async function applyIntegration(input = {}, options = {}) {
  if (!input.runId) throw new Error("runId is required for multitask apply.");
  const repo = options.repo || await getRepoInfo(options.cwd || process.cwd());
  const manifest = options.manifest || await loadManifest(repo.root, slugify(input.runId, "run"));
  const integration = manifest.integration;
  if (!integration?.branch) throw new Error(`Run ${manifest.runId} has no integration branch to apply.`);
  if (!(await branchExists(repo.root, integration.branch))) throw new Error(`Integration branch does not exist: ${integration.branch}`);
  if (input.requireClean !== false) await requireCleanForegroundCheckout(repo.root);

  const result = await git(repo.root, ["merge", "--no-ff", integration.branch, "-m", `multitask: apply ${manifest.runId}`], {
    allowFailure: true,
    timeoutSeconds: 300,
  });
  const apply = {
    branch: integration.branch,
    status: result.exitCode === 0 ? "applied" : "conflict",
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    completedAt: new Date().toISOString(),
  };

  if (result.exitCode === 0) {
    apply.commit = await getCurrentCommit(repo.root).catch(() => undefined);
    integration.status = "applied";
    integration.appliedAt = apply.completedAt;
    integration.applyCommit = apply.commit;
    manifest.status = "merged";
  } else {
    integration.status = "needs_attention";
    manifest.status = "needs_attention";
  }
  integration.apply = apply;
  await saveManifest(repo.root, manifest);
  await appendRunEvent(repo.root, manifest.runId, result.exitCode === 0 ? "integration_applied" : "integration_apply_conflict", apply);

  return {
    runId: manifest.runId,
    manifest,
    integration,
    apply,
    summary: summarizeApplyResult(manifest.runId, apply),
  };
}

module.exports = {
  applyIntegration,
  ensureIntegrationRecord,
  ensureIntegrationWorktree,
  mergeTasks,
  requireCleanForegroundCheckout,
  resolveIntegrationScriptsForMerge,
  summarizeApplyResult,
  summarizeMergeResult,
};
