const { loadConfig } = require("../config.js");
const { branchExists, createWorktree: defaultCreateWorktree, getRepoInfo, git } = require("../git.js");
const { runStartupScripts: defaultRunStartupScripts } = require("../hooks.js");
const { ensureDir, path, pathExists, slugify } = require("../utils.js");
const {
  TASK_STATUS,
  createRunStatusDto,
  createTaskStatusDto,
  inferRunStatusFromTasks,
} = require("./contracts.js");
const { appendRunEvent, appendTaskEvent } = require("./events.js");
const {
  createTaskRecord,
  loadManifest,
  normalizeTaskInputs,
  resolveTaskScripts,
  resolveWorktreeRoot,
  runDir,
  saveManifest,
  saveTaskState,
  taskPaths,
  taskSessionDir,
  tasksDir,
} = require("./manifest.js");

function nowIso(options = {}) {
  if (options.now) return typeof options.now === "function" ? options.now() : options.now;
  if (options.nowFactory) return options.nowFactory();
  return new Date().toISOString();
}

function taskInputList(input = {}) {
  if (Array.isArray(input)) return input;
  if (Array.isArray(input.tasks)) return input.tasks;
  if (input.tasks && typeof input.tasks === "object") return [input.tasks];
  if (input.task) return [input.task];
  if (input.prompt || input.id || input.name || input.title) return [input];
  return [];
}

function normalizeSpawnTasks(input = {}) {
  return normalizeTaskInputs(taskInputList(input));
}

function existingTaskIdSet(manifest = {}) {
  const ids = new Set();
  for (const task of manifest.tasks || []) {
    if (!task?.id) continue;
    ids.add(String(task.id));
    ids.add(slugify(task.id, "task"));
  }
  return ids;
}

function validateTaskIdUniqueness(manifest = {}, tasks = []) {
  const existing = existingTaskIdSet(manifest);
  for (const task of tasks || []) {
    const id = String(task.id || "");
    if (!id) throw new Error("Spawned multitask task is missing an id.");
    if (existing.has(id) || existing.has(slugify(id, "task"))) {
      throw new Error(`Porchestrator task id already exists in run ${manifest.runId || "unknown"}: ${id}`);
    }
    existing.add(id);
    existing.add(slugify(id, "task"));
  }
  return true;
}

function resolveSpawnTaskScripts(config, tasks) {
  return new Map((tasks || []).map((task) => [task.id, resolveTaskScripts(config, task)]));
}

function ensureManifestSpawnDefaults(manifest, repoRoot, config, input = {}) {
  if (!manifest.runId) throw new Error("Cannot spawn into a manifest without runId.");
  manifest.repoRoot = manifest.repoRoot || repoRoot;
  manifest.stateDir = manifest.stateDir || runDir(repoRoot, manifest.runId);
  manifest.worktreeRoot = manifest.worktreeRoot || resolveWorktreeRoot(repoRoot, config, input);
  manifest.tasks = Array.isArray(manifest.tasks) ? manifest.tasks : [];
  return manifest;
}

function applyOptionalTaskFields(record, normalizedTask) {
  for (const key of ["dependencies", "dependsOn", "blockedBy", "metadata", "parentTaskId", "spawnedBy"]) {
    if (normalizedTask[key] !== undefined) record[key] = normalizedTask[key];
  }
  if (normalizedTask.branch) record.branch = String(normalizedTask.branch);
  if (normalizedTask.worktree) record.worktree = String(normalizedTask.worktree);
  record.worker = {
    ...(record.worker || {}),
    sessionDir: record.paths.session,
  };
  return record;
}

function createSpawnTaskRecord(normalizedTask, context) {
  const record = createTaskRecord(normalizedTask, context);
  return applyOptionalTaskFields(record, normalizedTask);
}

function createSpawnTaskRecords(manifest, tasks, context = {}) {
  const repoRoot = context.repoRoot || manifest.repoRoot;
  const worktreeRoot = context.worktreeRoot || manifest.worktreeRoot;
  const taskScripts = context.taskScripts || new Map();
  const now = context.now || nowIso(context);
  return (tasks || []).map((task) => createSpawnTaskRecord(task, {
    repoRoot,
    runId: manifest.runId,
    worktreeRoot,
    now,
    taskScripts,
  }));
}

async function ensureSpawnTaskDirectories(repoRoot, manifest, task) {
  task.paths = task.paths || taskPaths(repoRoot, manifest.runId, task.id);
  task.worker = { ...(task.worker || {}), sessionDir: task.paths.session };
  await ensureDir(tasksDir(repoRoot, manifest.runId));
  await ensureDir(task.paths.dir);
  await ensureDir(taskSessionDir(repoRoot, manifest.runId, task.id));
  return task;
}

async function persistManifestWithInferredStatus(repoRoot, manifest) {
  manifest.status = inferRunStatusFromTasks(manifest.tasks || []);
  await saveManifest(repoRoot, manifest);
  return manifest;
}

async function setProvisionTaskStatus(repoRoot, manifest, task, status, extra = {}) {
  const fromStatus = task.status;
  Object.assign(task, extra, {
    status,
    updatedAt: extra.updatedAt || new Date().toISOString(),
  });
  await saveTaskState(repoRoot, manifest.runId, task);
  await persistManifestWithInferredStatus(repoRoot, manifest);
  await appendTaskEvent(repoRoot, manifest.runId, task.id, "task_status_changed", {
    fromStatus,
    status,
    ...extra,
  });
  return task;
}

async function appendTaskRecords(repoRoot, manifest, records, options = {}) {
  await ensureDir(runDir(repoRoot, manifest.runId));
  await ensureDir(tasksDir(repoRoot, manifest.runId));

  for (const task of records || []) {
    await ensureSpawnTaskDirectories(repoRoot, manifest, task);
    manifest.tasks.push(task);
    await saveTaskState(repoRoot, manifest.runId, task);
  }

  await persistManifestWithInferredStatus(repoRoot, manifest);

  for (const task of records || []) {
    await appendTaskEvent(repoRoot, manifest.runId, task.id, "task_created", {
      status: task.status,
      branch: task.branch,
      worktree: task.worktree,
      sessionDir: task.paths?.session,
      agent: task.agent,
    });
  }

  if ((records || []).length > 0) {
    await appendRunEvent(repoRoot, manifest.runId, "tasks_spawned", {
      taskIds: records.map((task) => task.id),
      source: options.source || "multitask_spawn",
    });
  }

  return { manifest, tasks: records };
}

async function prepareTaskWorktree(repoRoot, worktree, branch, baseRef, options = {}) {
  if (await branchExists(repoRoot, branch)) {
    const args = ["worktree", "add"];
    if (options.force) args.push("--force");
    args.push(worktree, branch);
    return git(repoRoot, args, { timeoutSeconds: options.timeoutSeconds ?? 180 });
  }
  return defaultCreateWorktree(repoRoot, worktree, branch, baseRef, options);
}

async function provisionSpawnedTask(repoRoot, manifest, task, context = {}) {
  const createWorktree = context.createWorktree || prepareTaskWorktree;
  const runStartupScripts = context.runStartupScripts || defaultRunStartupScripts;
  const baseRef = context.baseRef || manifest.baseRef || manifest.baseCommit || "HEAD";
  const scripts = context.taskScripts?.get(task.id)?.startup || [];
  const at = nowIso(context);

  await ensureSpawnTaskDirectories(repoRoot, manifest, task);
  await setProvisionTaskStatus(repoRoot, manifest, task, TASK_STATUS.CREATING_WORKTREE, { provisioningStartedAt: at });

  await ensureDir(path.dirname(task.worktree));
  if (await pathExists(task.worktree)) {
    if (context.reuseExistingWorktree !== true) {
      throw new Error(`Task worktree already exists for ${task.id}: ${task.worktree}`);
    }
    task.worktreeReused = true;
  } else {
    await createWorktree(repoRoot, task.worktree, task.branch, baseRef, context.worktreeOptions || {});
  }

  await setProvisionTaskStatus(repoRoot, manifest, task, TASK_STATUS.SETUP, { worktreeReadyAt: nowIso(context) });

  try {
    task.startupResults = await runStartupScripts(context.config, task.worktree, "worker", {
      runId: manifest.runId,
      runDir: runDir(repoRoot, manifest.runId),
      taskId: task.id,
    }, scripts);
  } catch (error) {
    if (Array.isArray(error.results)) task.startupResults = error.results;
    else if (error.commandResult) task.startupResults = [error.commandResult];
    throw error;
  }

  await saveTaskState(repoRoot, manifest.runId, task);
  await persistManifestWithInferredStatus(repoRoot, manifest);
  await appendTaskEvent(repoRoot, manifest.runId, task.id, "task_worktree_ready", {
    branch: task.branch,
    worktree: task.worktree,
    sessionDir: task.paths?.session,
    startupScripts: task.startupScripts,
  });

  await setProvisionTaskStatus(repoRoot, manifest, task, TASK_STATUS.QUEUED, {
    queuedAt: nowIso(context),
    note: context.queueNote || "Worker session startup is pending scheduler/daemon integration.",
  });

  return task;
}

async function markProvisionFailure(repoRoot, manifest, task, error) {
  await setProvisionTaskStatus(repoRoot, manifest, task, TASK_STATUS.FAILED, { error: error.message });
  await appendTaskEvent(repoRoot, manifest.runId, task.id, "task_setup_failed", { error: error.message });
  return task;
}

function compactSpawnResult(repoRoot, manifest, tasks, extra = {}) {
  const runStatus = createRunStatusDto(manifest);
  const taskStatuses = (tasks || []).map((task) => createTaskStatusDto(task, { runId: manifest.runId }));
  const summary = `Spawned ${taskStatuses.length} task(s) into run ${manifest.runId}: ${taskStatuses.map((task) => `${task.id}:${task.status}`).join(", ")}`;
  return {
    runId: manifest.runId,
    taskIds: taskStatuses.map((task) => task.id),
    taskStatuses,
    runStatus,
    status: runStatus,
    manifest,
    tasks,
    repoRoot,
    summary,
    ...extra,
  };
}

async function resolveSpawnContext(input = {}, options = {}) {
  const manifest = options.manifest;
  const repo = options.repo || (manifest?.repoRoot ? { root: manifest.repoRoot } : await getRepoInfo(options.cwd || process.cwd()));
  const repoRoot = repo.root;
  const runId = input.runId || manifest?.runId;
  if (!runId) throw new Error("runId is required to spawn multitask tasks.");
  const loadedManifest = manifest || await loadManifest(repoRoot, slugify(runId, "run"));
  const config = options.config || await loadConfig(repoRoot);
  ensureManifestSpawnDefaults(loadedManifest, repoRoot, config, input);
  return { repo, repoRoot, manifest: loadedManifest, config };
}

async function spawnTasks(input = {}, options = {}) {
  const { repoRoot, manifest, config } = await resolveSpawnContext(input, options);
  const normalizedTasks = normalizeSpawnTasks(input);
  validateTaskIdUniqueness(manifest, normalizedTasks);

  const taskScripts = resolveSpawnTaskScripts(config, normalizedTasks);
  const records = createSpawnTaskRecords(manifest, normalizedTasks, {
    repoRoot,
    worktreeRoot: manifest.worktreeRoot,
    taskScripts,
    now: nowIso(options),
  });

  await appendTaskRecords(repoRoot, manifest, records, options);

  const provision = options.provisionWorktrees !== false && input.provisionWorktrees !== false;
  const failures = [];

  if (provision) {
    for (const task of records) {
      try {
        await provisionSpawnedTask(repoRoot, manifest, task, {
          ...options,
          config,
          taskScripts,
          baseRef: input.baseRef || options.baseRef,
        });
      } catch (error) {
        failures.push({ taskId: task.id, error });
        await markProvisionFailure(repoRoot, manifest, task, error);
        if (options.continueOnProvisionFailure === false) break;
      }
    }
  } else {
    for (const task of records) {
      await setProvisionTaskStatus(repoRoot, manifest, task, TASK_STATUS.QUEUED, {
        queuedAt: nowIso(options),
        note: "Worktree provisioning was deferred.",
      });
    }
  }

  await persistManifestWithInferredStatus(repoRoot, manifest);
  await appendRunEvent(repoRoot, manifest.runId, failures.length ? "tasks_spawn_completed_with_failures" : "tasks_spawn_completed", {
    taskIds: records.map((task) => task.id),
    failedTaskIds: failures.map((failure) => failure.taskId),
  });

  const result = compactSpawnResult(repoRoot, manifest, records, { failures });
  if (failures.length && options.throwOnProvisionFailure === true) {
    const error = new Error(`Failed to provision ${failures.length} spawned multitask task(s): ${failures.map((failure) => `${failure.taskId}: ${failure.error.message}`).join("; ")}`);
    error.failures = failures;
    error.result = result;
    throw error;
  }
  return result;
}

module.exports = {
  appendTaskRecords,
  compactSpawnResult,
  createSpawnTaskRecord,
  createSpawnTaskRecords,
  normalizeSpawnTasks,
  prepareTaskWorktree,
  provisionSpawnedTask,
  resolveSpawnContext,
  resolveSpawnTaskScripts,
  spawnTasks,
  validateTaskIdUniqueness,
};
