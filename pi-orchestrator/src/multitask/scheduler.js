const {
  TASK_STATUS,
  inferRunStatusFromTasks,
  isRunningTaskStatus,
} = require("./contracts.js");
const { computeDependencyWaves, validateDependencyGraph } = require("./workflow.js");

const DEFAULT_MAX_CONCURRENCY = 1;

const DEFAULT_DEPENDENCY_READY_STATUSES = Object.freeze([
  TASK_STATUS.IDLE,
  TASK_STATUS.READY_FOR_REVIEW,
  TASK_STATUS.READY_TO_MERGE,
  TASK_STATUS.MERGED,
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function unique(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function asStringArray(values = []) {
  const list = Array.isArray(values) ? values : [values];
  return list.map((value) => String(value || "")).filter(Boolean);
}

function sameStringArray(a = [], b = []) {
  const left = asStringArray(a);
  const right = asStringArray(b);
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function nowIso(options = {}) {
  if (options.now) return typeof options.now === "function" ? options.now() : options.now;
  if (options.nowFactory) return options.nowFactory();
  return new Date().toISOString();
}

function coerceMaxConcurrency(value, fallback = DEFAULT_MAX_CONCURRENCY) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function schedulerMaxConcurrency(run = {}, options = {}) {
  return coerceMaxConcurrency(options.maxConcurrency ?? run.maxConcurrency, DEFAULT_MAX_CONCURRENCY);
}

function taskId(task) {
  const id = task?.id || task?.taskId;
  return id === undefined || id === null ? undefined : String(id);
}

function taskStatus(task) {
  return task?.status || TASK_STATUS.PLANNED;
}

function normalizeDependencyItem(item, currentTaskId) {
  if (!item) return [];
  if (typeof item === "string") return [item];
  if (typeof item !== "object") return [];

  // Edge form: { before: "api", after: "ui" } means api must finish before ui.
  if (item.before && item.after) return String(item.after) === String(currentTaskId) ? [item.before] : [];

  // Common prerequisite forms for task-local dependency declarations.
  return [item.taskId, item.id, item.dependsOn, item.before].filter(Boolean);
}

function dependencyItemsToIds(items, currentTaskId) {
  if (items === undefined || items === null) return [];
  const list = Array.isArray(items) ? items : [items];
  return list.flatMap((item) => normalizeDependencyItem(item, currentTaskId));
}

function dependencyIdsForTask(task, run = {}) {
  const id = taskId(task);
  const taskDependencies = dependencyItemsToIds(task?.dependencies, id)
    .concat(dependencyItemsToIds(task?.dependsOn, id));
  const runDependencies = dependencyItemsToIds(run.dependencies, id);

  // Treat blockedBy as persisted scheduler state unless no explicit dependency
  // declaration exists. This lets manually-blocked tasks stay blocked, while
  // dependency-blocked tasks can be re-evaluated from canonical dependencies.
  const explicit = taskDependencies.concat(runDependencies);
  const blockedBy = explicit.length > 0 ? [] : dependencyItemsToIds(task?.blockedBy, id).concat(
    typeof task?.blockedBy === "string" ? [task.blockedBy] : [],
  );

  return unique(explicit.concat(blockedBy));
}

function taskMapById(tasks = []) {
  return new Map(tasks.map((task) => [taskId(task), task]).filter(([id]) => Boolean(id)));
}

function createDependencyReadySet(options = {}) {
  return new Set(options.dependencyReadyStatuses || DEFAULT_DEPENDENCY_READY_STATUSES);
}

function defaultDependencySatisfied(prerequisite, context = {}) {
  if (!prerequisite) return false;
  return createDependencyReadySet(context.options || context).has(taskStatus(prerequisite));
}

function evaluateDependencyReadiness(task, run = {}, options = {}) {
  const prerequisites = dependencyIdsForTask(task, run);
  if (prerequisites.length === 0) {
    return { ready: true, prerequisites, pending: [], satisfied: [] };
  }

  const tasksById = taskMapById(run.tasks || []);
  const pending = [];
  const satisfied = [];
  const isSatisfied = typeof options.isDependencySatisfied === "function"
    ? options.isDependencySatisfied
    : defaultDependencySatisfied;

  for (const prerequisiteId of prerequisites) {
    const prerequisite = tasksById.get(prerequisiteId);
    if (prerequisite && isSatisfied(prerequisite, { task, run, prerequisiteId, options })) {
      satisfied.push(prerequisiteId);
    } else {
      pending.push(prerequisiteId);
    }
  }

  return { ready: pending.length === 0, prerequisites, pending, satisfied };
}

function makeTaskStatusUpdate(task, toStatus, reason, patch = {}, options = {}) {
  const id = taskId(task);
  const fromStatus = options.fromStatus || taskStatus(task);
  const at = options.at || nowIso(options);
  const nextPatch = {
    ...patch,
    status: toStatus,
    updatedAt: patch.updatedAt || at,
  };
  return {
    type: "task_status_update",
    taskId: id,
    fromStatus,
    toStatus,
    reason,
    patch: nextPatch,
  };
}

function eventForTaskUpdate(run, update, options = {}) {
  const runId = run.runId || run.id;
  const eventTypeByReason = {
    dependencies_pending: "task_blocked",
    dependencies_satisfied: "task_unblocked",
    scheduled: "worker_start_planned",
    task_transition: "task_status_changed",
  };
  return {
    scope: "task",
    type: eventTypeByReason[update.reason] || "task_status_changed",
    runId,
    taskId: update.taskId,
    status: update.toStatus,
    fromStatus: update.fromStatus,
    reason: update.reason,
    blockedBy: update.patch.blockedBy,
    time: options.at || nowIso(options),
  };
}

function collectSchedulerState(run = {}) {
  const tasks = run.tasks || [];
  return {
    queuedTaskIds: tasks.filter((task) => taskStatus(task) === TASK_STATUS.QUEUED).map(taskId),
    runningTaskIds: tasks.filter((task) => isRunningTaskStatus(taskStatus(task))).map(taskId),
    blockedTaskIds: tasks.filter((task) => taskStatus(task) === TASK_STATUS.BLOCKED).map(taskId),
  };
}

function schedulerDependencyGraph(run = {}) {
  const taskIds = (run.tasks || []).map(taskId).filter(Boolean);
  const dependencies = Array.isArray(run.dependencies) ? run.dependencies : [];
  if (dependencies.length === 0) {
    return {
      waves: run.workflow?.waves,
      taskWaves: run.workflow?.taskWaves,
    };
  }
  const validated = validateDependencyGraph({ taskIds, dependencies });
  return computeDependencyWaves(validated.taskIds, validated.dependencies);
}

function planSchedule(run = {}, options = {}) {
  const tasks = Array.isArray(run.tasks) ? run.tasks : [];
  const at = nowIso(options);
  const maxConcurrency = schedulerMaxConcurrency(run, options);
  const current = collectSchedulerState(run);
  const dependencyGraph = schedulerDependencyGraph(run);
  const runningTaskIds = [...current.runningTaskIds];
  const capacity = Math.max(0, maxConcurrency - runningTaskIds.length);
  const effectiveStatusByTaskId = new Map(tasks.map((task) => [taskId(task), taskStatus(task)]));
  const readinessByTaskId = new Map();
  const updates = [];
  const events = [];

  for (const task of tasks) {
    const id = taskId(task);
    const status = taskStatus(task);
    if (!id) continue;
    const readiness = evaluateDependencyReadiness(task, run, options);
    readinessByTaskId.set(id, readiness);

    if (status === TASK_STATUS.QUEUED && !readiness.ready) {
      const update = makeTaskStatusUpdate(task, TASK_STATUS.BLOCKED, "dependencies_pending", {
        blockedBy: readiness.pending,
      }, { ...options, at });
      updates.push(update);
      events.push(eventForTaskUpdate(run, update, { ...options, at }));
      effectiveStatusByTaskId.set(id, TASK_STATUS.BLOCKED);
    } else if (status === TASK_STATUS.BLOCKED && readiness.prerequisites.length > 0 && readiness.ready) {
      const update = makeTaskStatusUpdate(task, TASK_STATUS.QUEUED, "dependencies_satisfied", {
        blockedBy: [],
      }, { ...options, at });
      updates.push(update);
      events.push(eventForTaskUpdate(run, update, { ...options, at }));
      effectiveStatusByTaskId.set(id, TASK_STATUS.QUEUED);
    } else if (status === TASK_STATUS.BLOCKED && !readiness.ready && !sameStringArray(task.blockedBy || [], readiness.pending)) {
      const update = makeTaskStatusUpdate(task, TASK_STATUS.BLOCKED, "dependencies_pending", {
        blockedBy: readiness.pending,
      }, { ...options, at, fromStatus: TASK_STATUS.BLOCKED });
      updates.push(update);
      events.push(eventForTaskUpdate(run, update, { ...options, at }));
    }
  }

  const startableTaskIds = tasks
    .filter((task) => {
      const id = taskId(task);
      const readiness = readinessByTaskId.get(id) || evaluateDependencyReadiness(task, run, options);
      return effectiveStatusByTaskId.get(id) === TASK_STATUS.QUEUED && readiness.ready;
    })
    .map(taskId);
  const selectedTaskIds = startableTaskIds.slice(0, capacity);

  for (const id of selectedTaskIds) {
    const task = tasks.find((candidate) => taskId(candidate) === id);
    const update = makeTaskStatusUpdate(task, TASK_STATUS.RUNNING, "scheduled", {
      startedAt: at,
      blockedBy: [],
    }, { ...options, at, fromStatus: effectiveStatusByTaskId.get(id) });
    updates.push(update);
    events.push(eventForTaskUpdate(run, update, { ...options, at }));
    effectiveStatusByTaskId.set(id, TASK_STATUS.RUNNING);
  }

  const planned = {
    queuedTaskIds: tasks.filter((task) => effectiveStatusByTaskId.get(taskId(task)) === TASK_STATUS.QUEUED).map(taskId),
    runningTaskIds: tasks.filter((task) => effectiveStatusByTaskId.get(taskId(task)) === TASK_STATUS.RUNNING).map(taskId),
    blockedTaskIds: tasks.filter((task) => effectiveStatusByTaskId.get(taskId(task)) === TASK_STATUS.BLOCKED).map(taskId),
  };

  events.push({
    scope: "run",
    type: "scheduler_cycle_planned",
    runId: run.runId || run.id,
    maxConcurrency,
    capacity,
    selectedTaskIds,
    startableTaskIds,
    time: at,
  });

  return {
    runId: run.runId || run.id,
    maxConcurrency,
    capacity,
    current,
    planned,
    startableTaskIds,
    selectedTaskIds,
    startTaskIds: selectedTaskIds,
    dependencyWaves: dependencyGraph.waves,
    taskWaves: dependencyGraph.taskWaves,
    updates,
    events,
  };
}

function applyTaskUpdate(manifest, update) {
  const task = (manifest.tasks || []).find((candidate) => taskId(candidate) === update.taskId);
  if (!task) return;
  Object.assign(task, update.patch || {});
}

function applySchedulingPlan(run = {}, plan = {}, options = {}) {
  const manifest = options.mutate === true ? run : clone(run);
  for (const update of plan.updates || []) {
    if (update.type === "task_status_update") applyTaskUpdate(manifest, update);
  }
  if (options.updateRunStatus === true) {
    manifest.status = inferRunStatusFromTasks(manifest.tasks || []);
    manifest.updatedAt = nowIso(options);
  }
  return manifest;
}

function planAfterTaskTransition(run = {}, taskIdToUpdate, toStatus, options = {}) {
  const manifest = options.mutate === true ? run : clone(run);
  const task = (manifest.tasks || []).find((candidate) => taskId(candidate) === String(taskIdToUpdate));
  if (!task) throw new Error(`No multitask task ${taskIdToUpdate} in run ${manifest.runId || manifest.id || "unknown"}.`);

  const at = nowIso(options);
  const transitionPatch = { ...(options.patch || {}) };
  if (options.completedAt !== undefined) transitionPatch.completedAt = options.completedAt;
  const transition = makeTaskStatusUpdate(task, toStatus, "task_transition", transitionPatch, { ...options, at });
  applyTaskUpdate(manifest, transition);

  const schedule = planSchedule(manifest, { ...options, now: at });
  const event = eventForTaskUpdate(manifest, transition, { ...options, at });
  return {
    manifest,
    transition,
    schedule,
    updates: [transition, ...schedule.updates],
    events: [event, ...schedule.events],
    result: applySchedulingPlan(manifest, schedule, options),
  };
}

function completeTaskAndPlan(run = {}, taskIdToUpdate, options = {}) {
  return planAfterTaskTransition(
    run,
    taskIdToUpdate,
    options.status || TASK_STATUS.READY_FOR_REVIEW,
    {
      ...options,
      completedAt: options.completedAt || nowIso(options),
    },
  );
}

function idleTaskAndPlan(run = {}, taskIdToUpdate, options = {}) {
  return planAfterTaskTransition(run, taskIdToUpdate, TASK_STATUS.IDLE, options);
}

class Scheduler {
  constructor(run = {}, options = {}) {
    this.run = options.mutate === true ? run : clone(run);
    this.options = { ...options, mutate: true };
  }

  state() {
    return collectSchedulerState(this.run);
  }

  plan(options = {}) {
    return planSchedule(this.run, { ...this.options, ...options });
  }

  apply(plan, options = {}) {
    this.run = applySchedulingPlan(this.run, plan, { ...this.options, ...options, mutate: true });
    return this.run;
  }

  schedule(options = {}) {
    const plan = this.plan(options);
    this.apply(plan, options);
    return { plan, manifest: this.run };
  }

  complete(taskIdToUpdate, options = {}) {
    const result = completeTaskAndPlan(this.run, taskIdToUpdate, { ...this.options, ...options, mutate: true });
    this.run = result.result;
    return result;
  }

  idle(taskIdToUpdate, options = {}) {
    const result = idleTaskAndPlan(this.run, taskIdToUpdate, { ...this.options, ...options, mutate: true });
    this.run = result.result;
    return result;
  }
}

function createScheduler(run = {}, options = {}) {
  return new Scheduler(run, options);
}

module.exports = {
  DEFAULT_DEPENDENCY_READY_STATUSES,
  Scheduler,
  applySchedulingPlan,
  collectSchedulerState,
  completeTaskAndPlan,
  createScheduler,
  dependencyIdsForTask,
  evaluateDependencyReadiness,
  schedulerDependencyGraph,
  idleTaskAndPlan,
  planAfterTaskTransition,
  planSchedule,
  schedulerMaxConcurrency,
};
