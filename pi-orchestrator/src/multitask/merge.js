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
const { runStartupScripts, runValidationScripts, summarizeCommandResults } = require("../hooks.js");
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

async function gitStatus(cwd) {
  return git(cwd, ["status", "--porcelain", "--untracked-files=all"], { allowFailure: true });
}

async function currentBranch(cwd) {
  const result = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true });
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

function actionableGitOutput(result) {
  return [result?.stdout, result?.stderr].filter(Boolean).join("\n").trim();
}

function createDirtyWorktreeError(label, worktree, result, recovery) {
  const output = actionableGitOutput(result);
  const error = new Error([
    `${label} has uncommitted, untracked, or unresolved changes and Porchestrator refuses to continue by default.`,
    `Worktree: ${worktree}`,
    output ? `Git status:\n${output}` : undefined,
    recovery || "Commit, stash, discard, or resolve those changes before retrying.",
  ].filter(Boolean).join("\n"));
  error.status = result?.stdout;
  error.stderr = result?.stderr;
  return error;
}

async function requireCleanWorktree(cwd, label, recovery) {
  const status = await gitStatus(cwd);
  if (status.exitCode !== 0 || status.stdout.trim()) {
    throw createDirtyWorktreeError(label, cwd, status, recovery);
  }
}

function hasUnmergedStatusLine(line) {
  const status = String(line || "").slice(0, 2);
  return status.includes("U") || ["AA", "DD"].includes(status);
}

async function requireNoUnmergedWorktree(cwd, label, recovery) {
  const status = await gitStatus(cwd);
  const unmerged = status.stdout.split(/\r?\n/).filter(hasUnmergedStatusLine);
  if (status.exitCode !== 0 || unmerged.length) {
    throw createDirtyWorktreeError(label, cwd, { ...status, stdout: unmerged.join("\n") || status.stdout }, recovery);
  }
}

async function ensureIntegrationWorktreeOnBranch(integration) {
  const branch = await currentBranch(integration.worktree);
  if (branch && integration.branch && branch === integration.branch) return;
  if (!integration.branch && branch) return;
  const error = new Error([
    branch ? "Integration worktree is not checked out on the manifest integration branch." : "Integration worktree is not a readable git checkout.",
    `Worktree: ${integration.worktree}`,
    `Expected branch: ${integration.branch}`,
    `Actual branch: ${branch}`,
    "Switch the worktree back to the integration branch or clean up/recreate the run worktrees before merging.",
  ].join("\n"));
  error.expectedBranch = integration.branch;
  error.actualBranch = branch;
  throw error;
}

function formatMergeFailureMessage(task, integration, result, status) {
  const output = actionableGitOutput(result);
  return [
    `Merging task ${task.id} (${task.branch}) into integration branch ${integration.branch} failed with status ${status}.`,
    `Integration worktree: ${integration.worktree}`,
    output ? `Git output:\n${output}` : undefined,
    "Resolve conflicts in the integration worktree, commit the resolution on the integration branch, then retry multitask_merge or mark the task for changes.",
  ].filter(Boolean).join("\n");
}

async function ensureIntegrationWorktree(repoRoot, config, manifest, input = {}) {
  const integration = ensureIntegrationRecord(manifest, config);
  const scripts = resolveIntegrationScriptsForMerge(config, manifest, input);
  integration.startupScripts = scriptIds(scripts.startup);
  integration.validationScripts = scriptIds(scripts.validation);

  if (integration.worktree && await pathExists(integration.worktree)) {
    await ensureIntegrationWorktreeOnBranch(integration);
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

  await ensureIntegrationWorktreeOnBranch(integration);

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
    await requireNoUnmergedWorktree(task.worktree, `Task worktree ${task.id}`, "Resolve any in-progress merge/rebase in the worker worktree before merging it into integration.");
    const result = await addAndCommit(task.worktree, ["-A"], `multitask: checkpoint ${manifest.runId}/${task.id} before integration merge`);
    task.commit = result.commit;
    task.lastMergePreparation = {
      checkpoint: true,
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
  const lines = [`# Porchestrator Merge: ${runId}`, ""];
  if (!merges.length) lines.push("No ready tasks were selected for merge.");
  for (const merge of merges) {
    lines.push(`- ${merge.taskId}: ${merge.status}${merge.commit ? ` @ ${String(merge.commit).slice(0, 12)}` : ""}`);
    if (merge.message && merge.status !== "merged") lines.push(`  ${merge.message.split(/\r?\n/).join("\n  ")}`);
    else if (merge.stderr && merge.status !== "merged") lines.push(`  stderr: ${merge.stderr.trim()}`);
  }
  if (integration) {
    lines.push("", `Integration: ${integration.status}`);
    if (integration.branch) lines.push(`Branch: ${integration.branch}`);
    if (integration.worktree) lines.push(`Worktree: ${integration.worktree}`);
    if (integration.commit) lines.push(`Commit: ${integration.commit}`);
    if (Array.isArray(integration.validation)) {
      lines.push("", "Integration validation:", summarizeCommandResults(integration.validation));
    }
    if (integration.validationError) lines.push("", `Validation error: ${integration.validationError}`);
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
  if (input.requireCleanIntegration !== false) {
    await requireCleanWorktree(
      integration.worktree,
      "Integration worktree",
      "Resolve, commit, stash, or discard integration worktree changes before merging task branches. Pass requireCleanIntegration:false only after inspecting the worktree manually.",
    );
  }

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
    const status = result.exitCode === 0 ? "merged" : "conflict";
    const entry = {
      taskId: task.id,
      branch: task.branch,
      commit: task.commit,
      status,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      message: result.exitCode === 0 ? undefined : formatMergeFailureMessage(task, integration, result, status),
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

  delete integration.validationError;
  integration.validation = await runValidationScripts(config, integration.worktree, "integration", {
    runId: manifest.runId,
    runDir: runDir(repo.root, manifest.runId),
    taskId: "integration",
  }, scripts.validation).catch((error) => {
    integration.validationError = error.message;
    return error.results || [error.commandResult].filter(Boolean);
  });

  await appendRunEvent(repo.root, manifest.runId, "integration_validation_completed", {
    status: validationFailed(integration.validation) ? "failed" : "succeeded",
    results: (integration.validation || []).map((result) => ({
      id: result.id,
      name: result.name,
      status: result.status,
      required: result.required,
      exitCode: result.exitCode,
    })),
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
  const status = await gitStatus(repoRoot);
  const error = new Error([
    "Foreground checkout has uncommitted or untracked changes. multitask_apply refuses unsafe foreground checkouts by default.",
    `Checkout: ${repoRoot}`,
    status.stdout.trim() ? `Git status:\n${status.stdout.trim()}` : undefined,
    "Commit, stash, or discard foreground changes before applying integration results. Pass requireClean:false only after explicit user approval and manual inspection.",
  ].filter(Boolean).join("\n"));
  error.status = status.stdout;
  throw error;
}

function approvalToken(runId) {
  return `apply ${runId}`;
}

function requireApplyApproval(input, manifest, options = {}) {
  if (options.requireApproval === false || input.requireApproval === false) return;
  if (input.approved === true || input.confirm === approvalToken(manifest.runId)) return;
  const error = new Error([
    "multitask_apply requires explicit user approval before merging integration results into the foreground checkout.",
    `Run: ${manifest.runId}`,
    `Required confirmation token: ${approvalToken(manifest.runId)}`,
    "Pass approved:true only after the user has approved this apply operation, or pass the confirmation token for non-interactive automation.",
  ].join("\n"));
  error.code = "PI_MULTITASK_APPLY_APPROVAL_REQUIRED";
  error.requiredConfirmation = approvalToken(manifest.runId);
  throw error;
}

function requireIntegrationReadyForApply(integration, input = {}) {
  if (input.requireReady === false) return;
  if (integration.status === "ready") return;
  const error = new Error([
    "Integration is not ready to apply. multitask_apply requires successful integration merge and validation by default.",
    `Current integration status: ${integration.status || "unknown"}`,
    integration.validationError ? `Validation error: ${integration.validationError}` : undefined,
    Array.isArray(integration.validation) ? `Integration validation:\n${summarizeCommandResults(integration.validation)}` : undefined,
    "Run multitask_merge, resolve conflicts, and ensure required integration validation scripts succeed before applying. Pass requireReady:false only after explicit manual inspection.",
  ].filter(Boolean).join("\n"));
  error.code = "PI_MULTITASK_INTEGRATION_NOT_READY";
  error.integrationStatus = integration.status;
  throw error;
}

function formatApplyFailureMessage(manifest, integration, result) {
  const output = actionableGitOutput(result);
  return [
    `Applying integration branch ${integration.branch} for run ${manifest.runId} failed with a merge conflict or git error.`,
    `Foreground checkout: ${manifest.repoRoot || "current repository"}`,
    output ? `Git output:\n${output}` : undefined,
    "Resolve the foreground checkout conflict, commit or abort the merge, then rerun multitask_apply after explicit approval.",
  ].filter(Boolean).join("\n");
}

function summarizeApplyResult(runId, apply) {
  const lines = [`# Porchestrator Apply: ${runId}`, "", `Status: ${apply.status}`];
  if (apply.branch) lines.push(`Branch: ${apply.branch}`);
  if (apply.commit) lines.push(`Commit: ${apply.commit}`);
  if (apply.message && apply.status !== "applied") lines.push("", apply.message);
  else if (apply.stderr && apply.status !== "applied") lines.push("", apply.stderr.trim());
  return lines.join("\n");
}

async function applyIntegration(input = {}, options = {}) {
  if (!input.runId) throw new Error("runId is required for multitask apply.");
  const repo = options.repo || await getRepoInfo(options.cwd || process.cwd());
  const manifest = options.manifest || await loadManifest(repo.root, slugify(input.runId, "run"));
  manifest.repoRoot = manifest.repoRoot || repo.root;
  const integration = manifest.integration;
  if (!integration?.branch) throw new Error(`Run ${manifest.runId} has no integration branch to apply.`);
  requireApplyApproval(input, manifest, options);
  requireIntegrationReadyForApply(integration, input);
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
    message: result.exitCode === 0 ? undefined : formatApplyFailureMessage(manifest, integration, result),
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
  requireApplyApproval,
  requireCleanForegroundCheckout,
  resolveIntegrationScriptsForMerge,
  summarizeApplyResult,
  summarizeMergeResult,
};
