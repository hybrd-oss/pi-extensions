const {
  TASK_STATUS,
  WORKER_ATTACHMENT_STATE,
  isReadyTaskStatus,
  isTerminalTaskStatus,
} = require("./contracts.js");
const { loadManifest, taskPaths } = require("./manifest.js");
const {
  createWorkerSessionForTask,
  sendWorkerMessage,
  workerSessionKey,
} = require("./rpc-worker-session.js");
const { fsp, pathExists, slugify } = require("../utils.js");

const COMPLETED_ATTACHMENT_STATUSES = new Set([
  TASK_STATUS.READY_FOR_REVIEW,
  TASK_STATUS.READY_TO_MERGE,
  TASK_STATUS.MERGED,
  TASK_STATUS.FAILED,
  TASK_STATUS.ABORTED,
]);

const PERSISTED_WORKER_KEYS = Object.freeze([
  "startedAt",
  "lastResponseAt",
  "lastEventAt",
  "exitedAt",
  "command",
  "args",
  "pid",
  "processStatus",
  "activityStatus",
  "rpcState",
]);

function taskId(task = {}) {
  const id = task.id || task.taskId;
  return id === undefined || id === null ? undefined : String(id);
}

function normalizeRunId(runOrId, fallback) {
  if (typeof runOrId === "string") return runOrId;
  return runOrId?.runId || runOrId?.id || fallback;
}

function sessionDirForTask(task = {}, context = {}) {
  if (context.sessionDir) return context.sessionDir;
  if (task.worker?.sessionDir) return task.worker.sessionDir;
  if (task.paths?.session) return task.paths.session;
  const repoRoot = context.repoRoot || context.manifest?.repoRoot;
  const runId = normalizeRunId(context.manifest, context.runId || task.runId);
  const id = taskId(task);
  return repoRoot && runId && id ? taskPaths(repoRoot, runId, id).session : undefined;
}

function hasOwnDefined(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key) && object[key] !== undefined && object[key] !== null;
}

function hasPersistedWorkerMetadata(task = {}) {
  const worker = task.worker || {};
  return PERSISTED_WORKER_KEYS.some((key) => hasOwnDefined(worker, key));
}

function getSessionStatus(session) {
  if (!session) return undefined;
  if (typeof session.getStatus === "function") return session.getStatus();
  return session.status || session;
}

function sessionIsAlive(session) {
  if (!session) return false;
  if (session.isAlive === true) return true;
  const status = getSessionStatus(session);
  if (!status) return false;
  if (status.isAlive === true) return true;
  if (status.processStatus && ["running", "starting"].includes(String(status.processStatus))) return true;
  return false;
}

function sessionIsRunning(session) {
  if (!sessionIsAlive(session)) return false;
  if (session.isRunning === true) return true;
  const status = getSessionStatus(session);
  return status?.isRunning === true || status?.activityStatus === TASK_STATUS.RUNNING;
}

function sessionIsIdle(session) {
  if (!sessionIsAlive(session)) return false;
  if (session.isIdle === true) return true;
  const status = getSessionStatus(session);
  return status?.isIdle === true || status?.activityStatus === TASK_STATUS.IDLE;
}

function registryKeys(runId, id) {
  const run = slugify(runId || "run", "run");
  const task = slugify(id || "task", "task");
  return [
    workerSessionKey(runId || run, id || task),
    workerSessionKey(run, task),
    `${runId}/${id}`,
    `${run}/${task}`,
    id,
    task,
  ].filter(Boolean);
}

function getSessionFromRegistry(registry, runId, id) {
  if (!registry) return undefined;
  if (typeof registry.getWorkerSession === "function") {
    const session = registry.getWorkerSession(runId, id);
    if (session) return session;
  }
  const keys = registryKeys(runId, id);
  if (registry instanceof Map) {
    for (const key of keys) {
      if (registry.has(key)) return registry.get(key);
    }
    return undefined;
  }
  if (typeof registry === "object") {
    for (const key of keys) {
      if (registry[key]) return registry[key];
    }
  }
  return undefined;
}

async function inspectSessionDir(sessionDir, options = {}) {
  if (!sessionDir) {
    return { sessionDir, exists: false, hasEntries: false, entries: [], error: undefined };
  }
  if (typeof options.inspectSessionDir === "function") return options.inspectSessionDir(sessionDir);
  if (options.sessionDirInfo && Object.prototype.hasOwnProperty.call(options.sessionDirInfo, sessionDir)) {
    return { sessionDir, ...options.sessionDirInfo[sessionDir] };
  }
  if (typeof options.sessionDirExists === "function") {
    const exists = await options.sessionDirExists(sessionDir);
    return { sessionDir, exists: !!exists, hasEntries: !!exists && options.assumeExistingSessionDirHasEntries === true, entries: [] };
  }

  try {
    const exists = await pathExists(sessionDir);
    if (!exists) return { sessionDir, exists: false, hasEntries: false, entries: [] };
    let entries = [];
    try {
      entries = await fsp.readdir(sessionDir);
    } catch (error) {
      return { sessionDir, exists: true, hasEntries: false, entries: [], error: error.message };
    }
    return { sessionDir, exists: true, hasEntries: entries.length > 0, entries };
  } catch (error) {
    return { sessionDir, exists: false, hasEntries: false, entries: [], error: error.message };
  }
}

function taskLooksCompleted(task = {}) {
  const status = task.status;
  if (COMPLETED_ATTACHMENT_STATUSES.has(status)) return true;
  if (isTerminalTaskStatus(status)) return true;
  if (isReadyTaskStatus(status)) return true;
  const activity = String(task.worker?.activityStatus || task.activityStatus || "");
  return ["completed", "done"].includes(activity);
}

function taskManifestSaysRunning(task = {}) {
  return task.status === TASK_STATUS.RUNNING || task.worker?.activityStatus === TASK_STATUS.RUNNING;
}

function buildRecoverySuggestions(classification) {
  const taskLabel = classification.taskId ? `task ${classification.taskId}` : "this task";
  switch (classification.attachmentState) {
    case WORKER_ATTACHMENT_STATE.ATTACHED:
      return [`${taskLabel} is attached to the current daemon; send messages normally.`];
    case WORKER_ATTACHMENT_STATE.LOST_RUNNING:
      return [
        `${taskLabel} is marked running in the manifest, but no live worker handle is attached to this daemon.`,
        classification.canRestart
          ? "Use restartIfNeeded/resume to start a Pi RPC worker with the persisted session directory, then send a follow-up or decision message."
          : "Mark the task needs_attention and inspect the task logs/session directory before retrying; no usable session directory was found.",
      ];
    case WORKER_ATTACHMENT_STATE.COMPLETED:
      return [
        `${taskLabel} appears completed from persisted task state.`,
        classification.canRestart
          ? "If more work is needed, restart the session from its session directory and send a follow-up prompt."
          : "No restartable session directory was found; inspect the task transcript or spawn a follow-up task.",
      ];
    case WORKER_ATTACHMENT_STATE.DETACHED_IDLE:
    default:
      return [
        classification.hasPersistedSessionState
          ? `${taskLabel} has persisted idle worker state but is not attached to this daemon.`
          : `${taskLabel} is not attached to this daemon.`,
        classification.canRestart
          ? "Use restartIfNeeded/resume to reattach by starting a worker from the persisted session directory."
          : "No restart is needed unless the task should be started by the scheduler.",
      ];
  }
}

function classifyWorkerAttachment(task = {}, context = {}) {
  const runId = normalizeRunId(context.manifest, context.runId || task.runId);
  const id = taskId(task);
  const session = context.session || getSessionFromRegistry(context.workerSessions, runId, id);
  const sessionStatus = getSessionStatus(session);
  const liveSession = sessionIsAlive(session);
  const sessionDir = sessionDirForTask(task, { ...context, runId });
  const sessionDirInfo = context.sessionDirInfo || {};
  const hasPersistedSessionState = context.hasPersistedSessionState === true
    || hasPersistedWorkerMetadata(task)
    || sessionDirInfo.hasEntries === true;
  const sessionDirExists = context.sessionDirExists === true || sessionDirInfo.exists === true;
  const hasUsableSessionDir = !!sessionDir && (sessionDirExists || context.assumeSessionDirExists === true);

  let attachmentState;
  let reason;

  if (liveSession) {
    attachmentState = WORKER_ATTACHMENT_STATE.ATTACHED;
    reason = sessionIsRunning(session) ? "live_worker_running" : sessionIsIdle(session) ? "live_worker_idle" : "live_worker_attached";
  } else if (taskManifestSaysRunning(task)) {
    attachmentState = WORKER_ATTACHMENT_STATE.LOST_RUNNING;
    reason = "manifest_running_without_live_worker";
  } else if (taskLooksCompleted(task)) {
    attachmentState = WORKER_ATTACHMENT_STATE.COMPLETED;
    reason = "task_completed_without_live_worker";
  } else {
    attachmentState = WORKER_ATTACHMENT_STATE.DETACHED_IDLE;
    reason = hasPersistedSessionState ? "persisted_idle_session_without_live_worker" : "no_live_worker";
  }

  const restartPolicy = decideRestartPolicy({
    attachmentState,
    task,
    sessionDir,
    hasUsableSessionDir,
    hasPersistedSessionState,
  }, context);

  const classification = {
    runId,
    taskId: id,
    status: task.status,
    detectedAt: context.detectedAt || new Date().toISOString(),
    attachmentState,
    reason,
    sessionDir,
    sessionDirExists,
    hasPersistedSessionState,
    hasLiveSession: liveSession,
    sessionStatus,
    worker: {
      pid: sessionStatus?.pid ?? task.worker?.pid,
      processStatus: sessionStatus?.processStatus ?? task.worker?.processStatus,
      activityStatus: sessionStatus?.activityStatus ?? task.worker?.activityStatus ?? task.activityStatus,
      sessionDir,
    },
    canRestart: restartPolicy.canRestart,
    restartPolicy,
    suggestedTaskPatch: buildRecoveryTaskPatch({ attachmentState, task, restartPolicy, sessionDir, reason, detectedAt: context.detectedAt || new Date().toISOString() }),
  };
  classification.suggestions = buildRecoverySuggestions(classification);
  return classification;
}

async function classifyTaskRecovery(task = {}, context = {}) {
  const sessionDir = sessionDirForTask(task, context);
  const sessionDirInfo = await inspectSessionDir(sessionDir, context);
  return classifyWorkerAttachment(task, {
    ...context,
    sessionDir,
    sessionDirInfo,
    sessionDirExists: sessionDirInfo.exists,
    hasPersistedSessionState: context.hasPersistedSessionState || hasPersistedWorkerMetadata(task) || sessionDirInfo.hasEntries,
  });
}

function decideRestartPolicy(classificationInput = {}, options = {}) {
  const attachmentState = classificationInput.attachmentState;
  const task = classificationInput.task || {};
  const hasUsableSessionDir = classificationInput.hasUsableSessionDir === true;
  const allowCompletedRestart = options.allowCompletedRestart !== false;
  const allowLostRunningRestart = options.allowLostRunningRestart !== false;

  if (attachmentState === WORKER_ATTACHMENT_STATE.ATTACHED) {
    return {
      action: "use_attached",
      restartNeeded: false,
      canRestart: false,
      canMessage: true,
      requiresAttention: false,
    };
  }

  if (attachmentState === WORKER_ATTACHMENT_STATE.LOST_RUNNING) {
    return {
      action: hasUsableSessionDir && allowLostRunningRestart ? "restart_from_session" : "mark_needs_attention",
      restartNeeded: true,
      canRestart: hasUsableSessionDir && allowLostRunningRestart,
      canMessage: false,
      canMessageAfterRestart: hasUsableSessionDir && allowLostRunningRestart,
      requiresAttention: true,
      updateStatusTo: TASK_STATUS.NEEDS_ATTENTION,
      reason: "lost_running_worker",
    };
  }

  if (attachmentState === WORKER_ATTACHMENT_STATE.COMPLETED) {
    return {
      action: hasUsableSessionDir && allowCompletedRestart ? "restart_for_followup" : "inspect_completed",
      restartNeeded: false,
      canRestart: hasUsableSessionDir && allowCompletedRestart,
      canMessage: false,
      canMessageAfterRestart: hasUsableSessionDir && allowCompletedRestart,
      requiresAttention: false,
      reason: "completed_worker",
    };
  }

  const neverStarted = !hasPersistedWorkerMetadata(task) && classificationInput.hasPersistedSessionState !== true;
  return {
    action: hasUsableSessionDir && !neverStarted ? "restart_from_session" : "wait_for_scheduler",
    restartNeeded: hasUsableSessionDir && !neverStarted,
    canRestart: hasUsableSessionDir && !neverStarted,
    canMessage: false,
    canMessageAfterRestart: hasUsableSessionDir && !neverStarted,
    requiresAttention: false,
    reason: neverStarted ? "worker_not_started" : "detached_idle_worker",
  };
}

function buildRecoveryTaskPatch(classification = {}) {
  const patch = {
    worker: {
      attachmentState: classification.attachmentState,
      recoveryReason: classification.restartPolicy?.reason || classification.reason,
      recoveryAction: classification.restartPolicy?.action,
      sessionDir: classification.sessionDir || classification.task?.worker?.sessionDir || classification.task?.paths?.session,
    },
  };
  if (classification.attachmentState === WORKER_ATTACHMENT_STATE.LOST_RUNNING) {
    patch.status = TASK_STATUS.NEEDS_ATTENTION;
    patch.recovery = {
      reason: "lost_running_worker",
      detectedAt: classification.detectedAt,
      suggestion: "Restart/resume from the persisted session directory or inspect task logs before retrying.",
    };
  }
  return patch;
}

async function analyzeRunRecovery(manifest = {}, options = {}) {
  const runId = manifest.runId || manifest.id;
  const tasks = [];
  for (const task of manifest.tasks || []) {
    tasks.push(await classifyTaskRecovery(task, {
      ...options,
      manifest,
      runId,
      repoRoot: options.repoRoot || manifest.repoRoot,
    }));
  }

  const byState = (state) => tasks.filter((task) => task.attachmentState === state);
  const suggestions = tasks.flatMap((task) => task.suggestions.map((message) => ({
    runId,
    taskId: task.taskId,
    attachmentState: task.attachmentState,
    message,
  })));

  return {
    runId,
    tasks,
    attachedTasks: byState(WORKER_ATTACHMENT_STATE.ATTACHED),
    detachedIdleTasks: byState(WORKER_ATTACHMENT_STATE.DETACHED_IDLE),
    lostRunningTasks: byState(WORKER_ATTACHMENT_STATE.LOST_RUNNING),
    completedTasks: byState(WORKER_ATTACHMENT_STATE.COMPLETED),
    staleRunningTasks: byState(WORKER_ATTACHMENT_STATE.LOST_RUNNING),
    suggestions,
    summary: formatRecoverySummary({ runId, tasks }),
  };
}

async function detectStaleRunningTasks(manifest = {}, options = {}) {
  const report = await analyzeRunRecovery(manifest, options);
  return report.staleRunningTasks;
}

function formatRecoverySummary(report = {}) {
  const tasks = report.tasks || [];
  const count = (state) => tasks.filter((task) => task.attachmentState === state).length;
  const parts = [
    `${count(WORKER_ATTACHMENT_STATE.ATTACHED)} attached`,
    `${count(WORKER_ATTACHMENT_STATE.DETACHED_IDLE)} detached idle`,
    `${count(WORKER_ATTACHMENT_STATE.LOST_RUNNING)} lost running`,
    `${count(WORKER_ATTACHMENT_STATE.COMPLETED)} completed`,
  ];
  return `Recovery for ${report.runId || "run"}: ${parts.join(", ")}.`;
}

function formatRecoverySuggestions(reportOrClassification = {}) {
  if (Array.isArray(reportOrClassification.suggestions)) {
    return reportOrClassification.suggestions.map((suggestion) => {
      if (typeof suggestion === "string") return suggestion;
      const prefix = suggestion.taskId ? `${suggestion.taskId}: ` : "";
      return `${prefix}${suggestion.message}`;
    }).join("\n");
  }
  return "";
}

function selectTask(manifest = {}, taskIdToFind) {
  const wanted = slugify(taskIdToFind, "task");
  const task = (manifest.tasks || []).find((candidate) => candidate.id === taskIdToFind || candidate.id === wanted);
  if (!task) throw new Error(`No multitask task ${taskIdToFind} in run ${manifest.runId || manifest.id || "unknown"}.`);
  return task;
}

function setRegistrySession(registry, runId, id, session) {
  if (!registry || !session) return;
  const key = workerSessionKey(runId, id);
  if (registry instanceof Map) {
    registry.set(key, session);
    return;
  }
  if (typeof registry === "object") registry[key] = session;
}

async function resolveRestartInput(input = {}, options = {}) {
  const repoRoot = input.repoRoot || options.repoRoot || input.manifest?.repoRoot;
  const manifest = input.manifest || (repoRoot && input.runId ? await loadManifest(repoRoot, input.runId) : undefined);
  if (!manifest) throw new Error("manifest or repoRoot+runId is required for restartIfNeeded.");
  const runId = manifest.runId || input.runId;
  const task = input.task || selectTask(manifest, input.taskId);
  return { repoRoot: repoRoot || manifest.repoRoot, manifest, runId, task };
}

async function restartIfNeeded(input = {}, options = {}) {
  const { repoRoot, manifest, runId, task } = await resolveRestartInput(input, options);
  const id = taskId(task);
  const registry = input.workerSessions || options.workerSessions;
  const existingSession = input.session || getSessionFromRegistry(registry, runId, id);
  const classification = await classifyTaskRecovery(task, {
    ...options,
    manifest,
    repoRoot,
    runId,
    session: existingSession,
    workerSessions: registry,
  });

  const send = options.sendMessage || sendWorkerMessage;
  if (classification.attachmentState === WORKER_ATTACHMENT_STATE.ATTACHED && existingSession) {
    const messageResult = input.message !== undefined
      ? await send(existingSession, input.message, { mode: input.mode, images: input.images, ...(input.messageOptions || {}) })
      : undefined;
    return {
      runId,
      taskId: id,
      action: "use_attached",
      restarted: false,
      restartNeeded: false,
      session: existingSession,
      worker: getSessionStatus(existingSession),
      classification,
      messageResult,
    };
  }

  const shouldRestart = input.restartIfNeeded === true || options.restartIfNeeded === true;
  if (!shouldRestart) {
    return {
      runId,
      taskId: id,
      action: classification.restartPolicy.action,
      restarted: false,
      restartNeeded: classification.restartPolicy.restartNeeded,
      classification,
      suggestion: classification.suggestions.join("\n"),
    };
  }

  if (!classification.canRestart) {
    const error = new Error(`Worker session ${runId}/${id} cannot be restarted: ${classification.restartPolicy.action}. ${classification.suggestions.join(" ")}`);
    error.classification = classification;
    throw error;
  }

  const createSession = options.createSession || (async (sessionInput) => createWorkerSessionForTask(sessionInput, {
    ...(options.workerSessionOptions || {}),
    sessionDir: classification.sessionDir,
  }));
  const session = await createSession({ repoRoot, manifest, task, runId, taskId: id, sessionDir: classification.sessionDir, classification });
  const startSession = options.startSession || (async (workerSession) => workerSession.start());
  await startSession(session, { classification, manifest, task });
  setRegistrySession(registry, runId, id, session);

  const messageResult = input.message !== undefined
    ? await send(session, input.message, { mode: input.mode, images: input.images, ...(input.messageOptions || {}) })
    : undefined;

  return {
    runId,
    taskId: id,
    action: classification.restartPolicy.action,
    restarted: true,
    restartNeeded: false,
    session,
    worker: getSessionStatus(session),
    classification,
    messageResult,
  };
}

module.exports = {
  COMPLETED_ATTACHMENT_STATUSES,
  PERSISTED_WORKER_KEYS,
  analyzeRunRecovery,
  buildRecoverySuggestions,
  buildRecoveryTaskPatch,
  classifyTaskRecovery,
  classifyWorkerAttachment,
  decideRestartPolicy,
  detectStaleRunningTasks,
  formatRecoverySuggestions,
  formatRecoverySummary,
  getSessionFromRegistry,
  getSessionStatus,
  inspectSessionDir,
  restartIfNeeded,
  sessionDirForTask,
  sessionIsAlive,
};
