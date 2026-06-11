const CONTRACT_SCHEMA_VERSION = 1;

function freezeArray(values) {
  return Object.freeze([...values]);
}

function freezeObject(value) {
  return Object.freeze({ ...value });
}

const TASK_STATUS = freezeObject({
  PLANNED: "planned",
  CREATING_WORKTREE: "creating_worktree",
  SETUP: "setup",
  QUEUED: "queued",
  BLOCKED: "blocked",
  RUNNING: "running",
  IDLE: "idle",
  NEEDS_ATTENTION: "needs_attention",
  READY_FOR_REVIEW: "ready_for_review",
  NEEDS_CHANGES: "needs_changes",
  READY_TO_MERGE: "ready_to_merge",
  MERGED: "merged",
  FAILED: "failed",
  ABORTED: "aborted",
});

const TASK_STATUSES = freezeArray(Object.values(TASK_STATUS));
const TASK_STATUS_SET = new Set(TASK_STATUSES);

const WORKER_ATTACHMENT_STATE = freezeObject({
  ATTACHED: "attached",
  DETACHED_IDLE: "detached_idle",
  LOST_RUNNING: "lost_running",
  COMPLETED: "completed",
});

const WORKER_ATTACHMENT_STATES = freezeArray(Object.values(WORKER_ATTACHMENT_STATE));
const WORKER_ATTACHMENT_STATE_SET = new Set(WORKER_ATTACHMENT_STATES);

const MESSAGE_TYPE = freezeObject({
  ASSIGNMENT: "assignment",
  QUESTION: "question",
  INFORM: "inform",
  REVIEW_FEEDBACK: "review_feedback",
  DECISION: "decision",
  REPORT_DONE: "report_done",
  REPORT_BLOCKED: "report_blocked",
});

const MESSAGE_TYPES = freezeArray(Object.values(MESSAGE_TYPE));
const MESSAGE_TYPE_SET = new Set(MESSAGE_TYPES);

const MESSAGE_DIRECTION = freezeObject({
  SUPERVISOR_TO_WORKER: "supervisor_to_worker",
  WORKER_TO_SUPERVISOR: "worker_to_supervisor",
  SYSTEM: "system",
});

const MESSAGE_DIRECTIONS = freezeArray(Object.values(MESSAGE_DIRECTION));
const MESSAGE_DIRECTION_SET = new Set(MESSAGE_DIRECTIONS);

const MESSAGE_MODE = freezeObject({
  PROMPT: "prompt",
  STEER: "steer",
  FOLLOW_UP: "followUp",
});

const MESSAGE_MODES = freezeArray(Object.values(MESSAGE_MODE));
const MESSAGE_MODE_SET = new Set(MESSAGE_MODES);

const RUN_STATUS = freezeObject({
  PLANNED: "planned",
  STARTING: "starting",
  SETUP: "setup",
  QUEUED: "queued",
  RUNNING: "running",
  IDLE: "idle",
  NEEDS_ATTENTION: "needs_attention",
  READY_FOR_REVIEW: "ready_for_review",
  NEEDS_CHANGES: "needs_changes",
  READY_TO_MERGE: "ready_to_merge",
  MERGING: "merging",
  MERGED: "merged",
  FAILED: "failed",
  ABORTED: "aborted",
});

const RUN_STATUSES = freezeArray(Object.values(RUN_STATUS));
const RUN_STATUS_SET = new Set(RUN_STATUSES);

const TASK_STATUS_CATEGORY = freezeObject({
  PLANNED: "planned",
  PROVISIONING: "provisioning",
  QUEUED: "queued",
  BLOCKED: "blocked",
  RUNNING: "running",
  IDLE: "idle",
  ATTENTION: "attention",
  READY: "ready",
  TERMINAL: "terminal",
});

const TASK_STATUS_CATEGORIES = freezeArray(Object.values(TASK_STATUS_CATEGORY));

const TASK_STATUS_CATEGORY_BY_STATUS = freezeObject({
  [TASK_STATUS.PLANNED]: TASK_STATUS_CATEGORY.PLANNED,
  [TASK_STATUS.CREATING_WORKTREE]: TASK_STATUS_CATEGORY.PROVISIONING,
  [TASK_STATUS.SETUP]: TASK_STATUS_CATEGORY.PROVISIONING,
  [TASK_STATUS.QUEUED]: TASK_STATUS_CATEGORY.QUEUED,
  [TASK_STATUS.BLOCKED]: TASK_STATUS_CATEGORY.BLOCKED,
  [TASK_STATUS.RUNNING]: TASK_STATUS_CATEGORY.RUNNING,
  [TASK_STATUS.IDLE]: TASK_STATUS_CATEGORY.IDLE,
  [TASK_STATUS.NEEDS_ATTENTION]: TASK_STATUS_CATEGORY.ATTENTION,
  [TASK_STATUS.READY_FOR_REVIEW]: TASK_STATUS_CATEGORY.READY,
  [TASK_STATUS.NEEDS_CHANGES]: TASK_STATUS_CATEGORY.ATTENTION,
  [TASK_STATUS.READY_TO_MERGE]: TASK_STATUS_CATEGORY.READY,
  [TASK_STATUS.MERGED]: TASK_STATUS_CATEGORY.TERMINAL,
  [TASK_STATUS.FAILED]: TASK_STATUS_CATEGORY.TERMINAL,
  [TASK_STATUS.ABORTED]: TASK_STATUS_CATEGORY.TERMINAL,
});

const TERMINAL_TASK_STATUSES = freezeArray([
  TASK_STATUS.MERGED,
  TASK_STATUS.FAILED,
  TASK_STATUS.ABORTED,
]);

const ACTIVE_TASK_STATUSES = freezeArray(TASK_STATUSES.filter((status) => !TERMINAL_TASK_STATUSES.includes(status)));
const ATTENTION_TASK_STATUSES = freezeArray([
  TASK_STATUS.BLOCKED,
  TASK_STATUS.NEEDS_ATTENTION,
  TASK_STATUS.NEEDS_CHANGES,
]);
const READY_TASK_STATUSES = freezeArray([
  TASK_STATUS.READY_FOR_REVIEW,
  TASK_STATUS.READY_TO_MERGE,
]);
const QUEUED_TASK_STATUSES = freezeArray([
  TASK_STATUS.PLANNED,
  TASK_STATUS.CREATING_WORKTREE,
  TASK_STATUS.SETUP,
  TASK_STATUS.QUEUED,
]);
const RUNNING_TASK_STATUSES = freezeArray([
  TASK_STATUS.RUNNING,
]);

const TERMINAL_RUN_STATUSES = freezeArray([
  RUN_STATUS.MERGED,
  RUN_STATUS.FAILED,
  RUN_STATUS.ABORTED,
]);
const ACTIVE_RUN_STATUSES = freezeArray(RUN_STATUSES.filter((status) => !TERMINAL_RUN_STATUSES.includes(status)));

const TaskStatusDtoShape = Object.freeze({
  kind: "pi-multitask-task-status",
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  runId: "string",
  taskId: "string",
  id: "string alias of taskId for manifest/TUI compatibility",
  status: TASK_STATUSES,
  statusCategory: TASK_STATUS_CATEGORIES,
  title: "string?",
  agent: "string?",
  model: "string?",
  branch: "string?",
  worktree: "string?",
  createdAt: "ISO-8601 string?",
  updatedAt: "ISO-8601 string?",
  startedAt: "ISO-8601 string?",
  completedAt: "ISO-8601 string?",
  worker: {
    attachmentState: WORKER_ATTACHMENT_STATES,
    activityStatus: "string?",
    processStatus: "string?",
    pid: "number?",
    sessionDir: "string?",
  },
  diff: "object?",
  review: "object?",
  messageCounts: "Record<message type, number>?",
  lastMessageAt: "ISO-8601 string?",
  dependencies: "string[]?",
});

const RunStatusDtoShape = Object.freeze({
  kind: "pi-multitask-run-status",
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  runId: "string",
  id: "string alias of runId",
  runName: "string?",
  status: RUN_STATUSES,
  createdAt: "ISO-8601 string?",
  updatedAt: "ISO-8601 string?",
  baseRef: "string?",
  baseCommit: "string?",
  baseBranch: "string?",
  repoRoot: "string?",
  stateDir: "string?",
  worktreeRoot: "string?",
  maxConcurrency: "number?",
  tasks: "TaskStatusDto[]",
  taskCounts: "Record<task status, number>",
  boardCounts: "Record<status category, number>",
  queuedTaskCount: "number",
  runningTaskCount: "number",
  attentionTaskCount: "number",
  readyTaskCount: "number",
  activeTaskCount: "number",
  integration: "object?",
});

const StatusResponseDtoShape = Object.freeze({
  kind: "pi-multitask-status",
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  generatedAt: "ISO-8601 string",
  activeRunId: "string?",
  runs: "RunStatusDto[]",
  daemonStatus: "object?",
  totals: {
    runs: "number",
    tasks: "number",
    queuedTasks: "number",
    runningTasks: "number",
    attentionTasks: "number",
    readyTasks: "number",
  },
  summary: "string?",
});

const MessageDtoShape = Object.freeze({
  kind: "pi-multitask-message",
  schemaVersion: CONTRACT_SCHEMA_VERSION,
  id: "string?",
  runId: "string",
  taskId: "string?",
  type: MESSAGE_TYPES,
  direction: MESSAGE_DIRECTIONS,
  mode: MESSAGE_MODES,
  correlationId: "string?",
  from: "string?",
  to: "string?",
  text: "string",
  createdAt: "ISO-8601 string",
  payload: "object?",
});

function asSet(values) {
  return values instanceof Set ? values : new Set(values || []);
}

function isOneOf(value, values) {
  return asSet(values).has(String(value || ""));
}

function assertOneOf(value, values, label) {
  if (!isOneOf(value, values)) {
    const allowed = [...asSet(values)].join(", ");
    throw new Error(`${label} must be one of: ${allowed}. Received: ${value}`);
  }
  return value;
}

function isTaskStatus(status) {
  return isOneOf(status, TASK_STATUS_SET);
}

function assertTaskStatus(status) {
  return assertOneOf(status, TASK_STATUS_SET, "task status");
}

function isRunStatus(status) {
  return isOneOf(status, RUN_STATUS_SET);
}

function assertRunStatus(status) {
  return assertOneOf(status, RUN_STATUS_SET, "run status");
}

function isWorkerAttachmentState(state) {
  return isOneOf(state, WORKER_ATTACHMENT_STATE_SET);
}

function assertWorkerAttachmentState(state) {
  return assertOneOf(state, WORKER_ATTACHMENT_STATE_SET, "worker attachment state");
}

function isMessageType(type) {
  return isOneOf(type, MESSAGE_TYPE_SET);
}

function assertMessageType(type) {
  return assertOneOf(type, MESSAGE_TYPE_SET, "message type");
}

function isMessageDirection(direction) {
  return isOneOf(direction, MESSAGE_DIRECTION_SET);
}

function assertMessageDirection(direction) {
  return assertOneOf(direction, MESSAGE_DIRECTION_SET, "message direction");
}

function isMessageMode(mode) {
  return isOneOf(mode, MESSAGE_MODE_SET);
}

function assertMessageMode(mode) {
  return assertOneOf(mode, MESSAGE_MODE_SET, "message mode");
}

function taskStatusCategory(status) {
  assertTaskStatus(status);
  return TASK_STATUS_CATEGORY_BY_STATUS[status];
}

function countBy(items, getKey, keys = []) {
  const counts = {};
  for (const key of keys) counts[key] = 0;
  for (const item of items || []) {
    const key = getKey(item);
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function isTerminalTaskStatus(status) {
  return TERMINAL_TASK_STATUSES.includes(String(status || ""));
}

function isAttentionTaskStatus(status) {
  return ATTENTION_TASK_STATUSES.includes(String(status || ""));
}

function isReadyTaskStatus(status) {
  return READY_TASK_STATUSES.includes(String(status || ""));
}

function isQueuedTaskStatus(status) {
  return QUEUED_TASK_STATUSES.includes(String(status || ""));
}

function isRunningTaskStatus(status) {
  return RUNNING_TASK_STATUSES.includes(String(status || ""));
}

function isTerminalRunStatus(status) {
  return TERMINAL_RUN_STATUSES.includes(String(status || ""));
}

function defaultAttachmentStateForTask(task) {
  if (task?.worker?.attachmentState) return assertWorkerAttachmentState(task.worker.attachmentState);
  const workerProcessStatus = String(task?.worker?.processStatus || "");
  const workerActivityStatus = String(task?.worker?.activityStatus || task?.activityStatus || "");
  if (workerProcessStatus === "running" || task?.worker?.pid) return WORKER_ATTACHMENT_STATE.ATTACHED;
  if (isTerminalTaskStatus(task?.status)) return WORKER_ATTACHMENT_STATE.COMPLETED;
  if (task?.status === TASK_STATUS.RUNNING || workerActivityStatus === TASK_STATUS.RUNNING) return WORKER_ATTACHMENT_STATE.LOST_RUNNING;
  return WORKER_ATTACHMENT_STATE.DETACHED_IDLE;
}

function compactWorkerDto(task = {}) {
  const worker = task.worker || {};
  return {
    attachmentState: defaultAttachmentStateForTask(task),
    activityStatus: worker.activityStatus || task.activityStatus,
    processStatus: worker.processStatus,
    pid: worker.pid,
    sessionDir: worker.sessionDir || task.paths?.session,
    lastStateAt: worker.lastStateAt,
  };
}

function createTaskStatusDto(task = {}, context = {}) {
  const status = task.status || TASK_STATUS.PLANNED;
  assertTaskStatus(status);
  const runId = context.runId || task.runId;
  const taskId = task.id || task.taskId;
  if (!taskId) throw new Error("task status DTO requires task.id or task.taskId.");
  return {
    kind: "pi-multitask-task-status",
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    runId,
    taskId,
    id: taskId,
    title: task.title,
    status,
    statusCategory: taskStatusCategory(status),
    agent: task.agent,
    model: task.model,
    branch: task.branch,
    worktree: task.worktree,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    worker: compactWorkerDto(task),
    diff: task.diff,
    review: task.review,
    messageCounts: task.messageCounts,
    lastMessageAt: task.lastMessageAt,
    dependencies: task.dependencies || task.dependsOn,
    blockedBy: task.blockedBy,
    error: task.error,
  };
}

function inferRunStatusFromTasks(tasks) {
  if (!tasks.length) return RUN_STATUS.PLANNED;
  if (tasks.some((task) => isAttentionTaskStatus(task.status))) return RUN_STATUS.NEEDS_ATTENTION;
  if (tasks.some((task) => isRunningTaskStatus(task.status))) return RUN_STATUS.RUNNING;
  if (tasks.some((task) => isQueuedTaskStatus(task.status))) return RUN_STATUS.QUEUED;
  if (tasks.some((task) => task.status === TASK_STATUS.READY_TO_MERGE)) return RUN_STATUS.READY_TO_MERGE;
  if (tasks.some((task) => task.status === TASK_STATUS.READY_FOR_REVIEW)) return RUN_STATUS.READY_FOR_REVIEW;
  if (tasks.every((task) => task.status === TASK_STATUS.MERGED)) return RUN_STATUS.MERGED;
  if (tasks.every((task) => isTerminalTaskStatus(task.status))) return RUN_STATUS.IDLE;
  return RUN_STATUS.IDLE;
}

function createRunStatusDto(run = {}) {
  const runId = run.runId || run.id;
  if (!runId) throw new Error("run status DTO requires run.runId or run.id.");
  const tasks = (run.tasks || []).map((task) => createTaskStatusDto(task, { runId }));
  const status = run.status || inferRunStatusFromTasks(tasks);
  assertRunStatus(status);
  const taskCounts = countBy(tasks, (task) => task.status, TASK_STATUSES);
  const boardCounts = countBy(tasks, (task) => task.statusCategory, TASK_STATUS_CATEGORIES);
  const activeTaskCount = tasks.filter((task) => !isTerminalTaskStatus(task.status)).length;
  return {
    kind: "pi-multitask-run-status",
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    runId,
    id: runId,
    runName: run.runName || run.name,
    displayName: run.runName || run.name || runId,
    status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    baseRef: run.baseRef,
    baseCommit: run.baseCommit,
    baseBranch: run.baseBranch,
    repoRoot: run.repoRoot,
    stateDir: run.stateDir,
    worktreeRoot: run.worktreeRoot,
    maxConcurrency: run.maxConcurrency,
    tasks,
    taskCounts,
    boardCounts,
    queuedTaskCount: tasks.filter((task) => task.status === TASK_STATUS.QUEUED).length,
    runningTaskCount: tasks.filter((task) => isRunningTaskStatus(task.status)).length,
    attentionTaskCount: tasks.filter((task) => isAttentionTaskStatus(task.status)).length,
    readyTaskCount: tasks.filter((task) => isReadyTaskStatus(task.status)).length,
    activeTaskCount,
    integration: run.integration,
  };
}

function normalizeStatusInput(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  if (Array.isArray(input.runs)) return input.runs;
  if (Array.isArray(input.manifests)) return input.manifests;
  if (input.manifest) return [input.manifest];
  if (input.run) return [input.run];
  if (input.kind === "pi-multitask-run" || input.kind === "pi-multitask-run-status" || input.runId || input.id) return [input];
  return [];
}

function createStatusResponseDto(input = {}, options = {}) {
  const runs = normalizeStatusInput(input).map(createRunStatusDto);
  const totals = runs.reduce((sum, run) => ({
    runs: sum.runs + 1,
    tasks: sum.tasks + run.tasks.length,
    queuedTasks: sum.queuedTasks + run.queuedTaskCount,
    runningTasks: sum.runningTasks + run.runningTaskCount,
    attentionTasks: sum.attentionTasks + run.attentionTaskCount,
    readyTasks: sum.readyTasks + run.readyTaskCount,
  }), { runs: 0, tasks: 0, queuedTasks: 0, runningTasks: 0, attentionTasks: 0, readyTasks: 0 });
  return {
    kind: "pi-multitask-status",
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    generatedAt: options.generatedAt || new Date().toISOString(),
    activeRunId: options.activeRunId || input.activeRunId,
    runs,
    daemonStatus: input.daemonStatus,
    totals,
    summary: input.summary,
  };
}

function createMessageDto(message = {}, context = {}) {
  const type = message.type || context.type || MESSAGE_TYPE.INFORM;
  assertMessageType(type);
  const direction = message.direction || context.direction || MESSAGE_DIRECTION.SUPERVISOR_TO_WORKER;
  assertMessageDirection(direction);
  const mode = message.mode || context.mode || MESSAGE_MODE.FOLLOW_UP;
  assertMessageMode(mode);
  const runId = message.runId || context.runId;
  if (!runId) throw new Error("message DTO requires runId.");
  const text = message.text ?? message.message ?? message.summary ?? "";
  if (typeof text !== "string") throw new Error("message DTO text must be a string.");
  return {
    kind: "pi-multitask-message",
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    id: message.id,
    runId,
    taskId: message.taskId || context.taskId,
    type,
    direction,
    mode,
    correlationId: message.correlationId,
    from: message.from,
    to: message.to,
    text,
    createdAt: message.createdAt || context.createdAt || new Date().toISOString(),
    payload: message.payload,
  };
}

module.exports = {
  ACTIVE_RUN_STATUSES,
  ACTIVE_TASK_STATUSES,
  ATTENTION_TASK_STATUSES,
  CONTRACT_SCHEMA_VERSION,
  MESSAGE_DIRECTION,
  MESSAGE_DIRECTIONS,
  MESSAGE_MODE,
  MESSAGE_MODES,
  MESSAGE_TYPE,
  MESSAGE_TYPES,
  MessageDtoShape,
  QUEUED_TASK_STATUSES,
  READY_TASK_STATUSES,
  RUNNING_TASK_STATUSES,
  RUN_STATUS,
  RUN_STATUSES,
  RunStatusDtoShape,
  STATUS_RESPONSE_DTO_SHAPE: StatusResponseDtoShape,
  StatusResponseDtoShape,
  TASK_STATUS,
  TASK_STATUSES,
  TASK_STATUS_CATEGORIES,
  TASK_STATUS_CATEGORY,
  TASK_STATUS_CATEGORY_BY_STATUS,
  TERMINAL_RUN_STATUSES,
  TERMINAL_TASK_STATUSES,
  TaskStatusDtoShape,
  WORKER_ATTACHMENT_STATE,
  WORKER_ATTACHMENT_STATES,
  assertMessageDirection,
  assertMessageMode,
  assertMessageType,
  assertRunStatus,
  assertTaskStatus,
  assertWorkerAttachmentState,
  createMessageDto,
  createRunStatusDto,
  createStatusResponseDto,
  createTaskStatusDto,
  inferRunStatusFromTasks,
  isAttentionTaskStatus,
  isMessageDirection,
  isMessageMode,
  isMessageType,
  isOneOf,
  isQueuedTaskStatus,
  isReadyTaskStatus,
  isRunStatus,
  isRunningTaskStatus,
  isTaskStatus,
  isTerminalRunStatus,
  isTerminalTaskStatus,
  isWorkerAttachmentState,
  normalizeStatusInput,
  taskStatusCategory,
};
