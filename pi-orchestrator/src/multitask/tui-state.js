const {
  ATTENTION_TASK_STATUSES: CONTRACT_ATTENTION_TASK_STATUSES,
  QUEUED_TASK_STATUSES: CONTRACT_QUEUED_TASK_STATUSES,
  READY_TASK_STATUSES: CONTRACT_READY_TASK_STATUSES,
  RUNNING_TASK_STATUSES: CONTRACT_RUNNING_TASK_STATUSES,
  TASK_STATUS_CATEGORY,
  TERMINAL_RUN_STATUSES,
  TERMINAL_TASK_STATUSES,
} = require("./contracts.js");

const TERMINAL_RUN_STATES = new Set([...TERMINAL_RUN_STATUSES, "cancelled"]);
const TERMINAL_TASK_STATES = new Set([...TERMINAL_TASK_STATUSES, "cancelled"]);
const ATTENTION_TASK_STATES = new Set([...CONTRACT_ATTENTION_TASK_STATUSES, "validation_failed", "failed"]);
const READY_TASK_STATES = new Set(CONTRACT_READY_TASK_STATUSES);
const QUEUED_TASK_STATES = new Set(CONTRACT_QUEUED_TASK_STATUSES);
const RUNNING_TASK_STATES = new Set(CONTRACT_RUNNING_TASK_STATUSES);

const BOARD_ORDER = Object.freeze([
  TASK_STATUS_CATEGORY.QUEUED,
  TASK_STATUS_CATEGORY.RUNNING,
  TASK_STATUS_CATEGORY.ATTENTION,
  TASK_STATUS_CATEGORY.READY,
  TASK_STATUS_CATEGORY.BLOCKED,
  TASK_STATUS_CATEGORY.IDLE,
  TASK_STATUS_CATEGORY.PROVISIONING,
  TASK_STATUS_CATEGORY.TERMINAL,
]);

const BOARD_LABELS = Object.freeze({
  [TASK_STATUS_CATEGORY.QUEUED]: "Queued",
  [TASK_STATUS_CATEGORY.RUNNING]: "Running",
  [TASK_STATUS_CATEGORY.ATTENTION]: "Needs attention",
  [TASK_STATUS_CATEGORY.READY]: "Ready",
  [TASK_STATUS_CATEGORY.BLOCKED]: "Blocked",
  [TASK_STATUS_CATEGORY.IDLE]: "Idle",
  [TASK_STATUS_CATEGORY.PROVISIONING]: "Provisioning",
  [TASK_STATUS_CATEGORY.TERMINAL]: "Done",
  planned: "Planned",
  other: "Other",
});

const STATUS_LABELS = Object.freeze({
  creating_worktree: "creating worktree",
  needs_attention: "needs attention",
  ready_for_review: "ready for review",
  validation_failed: "validation failed",
  ready_to_merge: "ready to merge",
  needs_changes: "needs changes",
  detached_idle: "detached idle",
  lost_running: "lost running",
});

const COMPACT_STATUS_LABELS = Object.freeze({
  creating_worktree: "creating",
  needs_attention: "attention",
  ready_for_review: "ready review",
  validation_failed: "validation failed",
  ready_to_merge: "ready merge",
  needs_changes: "changes",
  detached_idle: "detached",
  lost_running: "lost",
});

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatStatus(status, options = {}) {
  const value = String(status || "unknown");
  const labels = options.compact ? COMPACT_STATUS_LABELS : STATUS_LABELS;
  return labels[value] || value.replace(/_/g, " ");
}

function isTerminalRun(runOrStatus) {
  const status = typeof runOrStatus === "string" ? runOrStatus : runOrStatus?.status;
  return TERMINAL_RUN_STATES.has(String(status || ""));
}

function isTerminalTask(taskOrStatus) {
  const status = typeof taskOrStatus === "string" ? taskOrStatus : taskOrStatus?.status;
  return TERMINAL_TASK_STATES.has(String(status || ""));
}

function isActiveRun(run) {
  return run && !isTerminalRun(run);
}

function isActiveTask(task) {
  return task && !isTerminalTask(task);
}

function isAttentionTask(task) {
  return ATTENTION_TASK_STATES.has(String(task?.status || "")) || task?.statusCategory === TASK_STATUS_CATEGORY.ATTENTION;
}

function isReadyTask(task) {
  return READY_TASK_STATES.has(String(task?.status || "")) || task?.statusCategory === TASK_STATUS_CATEGORY.READY;
}

function isQueuedTask(task) {
  return QUEUED_TASK_STATES.has(String(task?.status || "")) || task?.statusCategory === TASK_STATUS_CATEGORY.QUEUED;
}

function isRunningTask(task) {
  return RUNNING_TASK_STATES.has(String(task?.status || "")) || task?.statusCategory === TASK_STATUS_CATEGORY.RUNNING;
}

function truncatePlain(value, width, ellipsis = "…") {
  const text = String(value || "");
  if (!Number.isFinite(width) || width <= 0 || text.length <= width) return text;
  if (width <= ellipsis.length) return ellipsis.slice(0, width);
  return text.slice(0, width - ellipsis.length) + ellipsis;
}

function pad(value, width) {
  return truncatePlain(value, width).padEnd(width, " ");
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

function countBy(items, getKey, keys = []) {
  const counts = {};
  for (const key of keys || []) counts[key] = 0;
  for (const item of items || []) {
    const key = getKey(item) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function numeric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function changedFilesCount(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.length;
  return undefined;
}

function getChangedFiles(task) {
  const candidates = [
    task?.changedFiles,
    task?.filesChanged,
    task?.diff?.changedFiles,
    task?.diff?.files,
    task?.summary?.changedFiles,
    task?.review?.changedFiles,
  ];
  for (const candidate of candidates) if (Array.isArray(candidate)) return candidate;
  return [];
}

function getChangedFilesCount(task) {
  return changedFilesCount(task?.changedFiles) ??
    changedFilesCount(task?.filesChanged) ??
    changedFilesCount(task?.diff?.changedFiles) ??
    changedFilesCount(task?.diff?.files) ??
    changedFilesCount(task?.summary?.changedFiles) ??
    changedFilesCount(task?.review?.changedFiles);
}

function formatChangedFiles(task) {
  const count = getChangedFilesCount(task);
  if (count !== undefined) return plural(count, "file") + " changed";
  if (typeof task?.diffSummary === "string" && task.diffSummary.trim()) return task.diffSummary.trim();
  if (typeof task?.diff?.summary === "string" && task.diff.summary.trim()) return task.diff.summary.trim();
  return undefined;
}

function workerActivity(task) {
  return task?.worker?.activityStatus || task?.worker?.status || task?.activityStatus || undefined;
}

function workerAttachment(task) {
  return task?.worker?.attachmentState || task?.worker?.attachment || task?.attachmentState || undefined;
}

function inferTaskCategory(task) {
  if (task?.statusCategory) return task.statusCategory;
  if (isQueuedTask(task)) return TASK_STATUS_CATEGORY.QUEUED;
  if (isRunningTask(task)) return TASK_STATUS_CATEGORY.RUNNING;
  if (isAttentionTask(task)) return TASK_STATUS_CATEGORY.ATTENTION;
  if (isReadyTask(task)) return TASK_STATUS_CATEGORY.READY;
  if (task?.status === "blocked") return TASK_STATUS_CATEGORY.BLOCKED;
  if (task?.status === "idle") return TASK_STATUS_CATEGORY.IDLE;
  if (task?.status === "creating_worktree" || task?.status === "setup") return TASK_STATUS_CATEGORY.PROVISIONING;
  if (isTerminalTask(task)) return TASK_STATUS_CATEGORY.TERMINAL;
  if (task?.status === "planned") return "planned";
  return "other";
}

function normalizeTask(task = {}, run) {
  const status = task.status || "unknown";
  const taskId = task.id || task.taskId || "task";
  const normalized = {
    ...task,
    id: taskId,
    taskId,
    runId: task.runId || run?.runId,
    status,
    statusLabel: formatStatus(status),
    compactStatusLabel: formatStatus(status, { compact: true }),
    title: task.title,
    branch: task.branch,
    worktree: task.worktree,
    workerActivity: workerActivity(task),
    workerAttachment: workerAttachment(task),
    changedFiles: getChangedFiles(task),
    changedFilesText: formatChangedFiles(task),
    lastEvents: Array.isArray(task.lastEvents) ? task.lastEvents : Array.isArray(task.events) ? task.events : [],
    transcriptTail: Array.isArray(task.transcriptTail) ? task.transcriptTail : Array.isArray(task.transcript) ? task.transcript : [],
  };
  normalized.statusCategory = inferTaskCategory(normalized);
  normalized.attention = isAttentionTask(normalized);
  normalized.ready = isReadyTask(normalized);
  normalized.queued = isQueuedTask(normalized);
  normalized.running = isRunningTask(normalized);
  normalized.active = isActiveTask(normalized);
  return normalized;
}

function runCount(run, key, fallback) {
  const direct = numeric(run?.[key]);
  if (direct !== undefined) return direct;
  return fallback;
}

function normalizeRun(run = {}) {
  const status = run.status || "unknown";
  const runId = run.runId || run.id || run.runName || run.name || "multitask";
  const tasks = (run.tasks || []).map((task) => normalizeTask(task, { ...run, runId }));
  const displayName = run.displayName || run.runName || run.name || runId;
  const taskCounts = { ...countBy(tasks, (task) => task.status), ...(run.taskCounts || {}) };
  const boardCounts = { ...countBy(tasks, (task) => task.statusCategory), ...(run.boardCounts || {}) };
  const queuedTaskCount = runCount(run, "queuedTaskCount", tasks.filter(isQueuedTask).length);
  const runningTaskCount = runCount(run, "runningTaskCount", tasks.filter(isRunningTask).length);
  const attentionTaskCount = runCount(run, "attentionTaskCount", tasks.filter(isAttentionTask).length);
  const readyTaskCount = runCount(run, "readyTaskCount", tasks.filter(isReadyTask).length);
  const activeTaskCount = runCount(run, "activeTaskCount", tasks.filter(isActiveTask).length);
  return {
    ...run,
    runId,
    id: runId,
    runName: run.runName || run.name,
    displayName,
    status,
    statusLabel: formatStatus(status),
    compactStatusLabel: formatStatus(status, { compact: true }),
    tasks,
    active: isActiveRun({ status }),
    taskCounts,
    boardCounts,
    queuedTaskCount,
    runningTaskCount,
    attentionTaskCount,
    readyTaskCount,
    activeTaskCount,
  };
}

function createTuiState(statusData, options = {}) {
  const runs = normalizeStatusInput(statusData).map(normalizeRun);
  const activeRuns = runs.filter(isActiveRun);
  const tasks = runs.flatMap((run) => run.tasks.map((task) => ({ run, task })));
  const activeTasks = tasks.filter(({ task }) => isActiveTask(task));
  return {
    kind: "pi-multitask-tui-state",
    generatedAt: options.now || options.generatedAt || statusData?.generatedAt || new Date().toISOString(),
    activeRunId: statusData?.activeRunId,
    daemonStatus: statusData?.daemonStatus,
    runs,
    activeRuns,
    totals: {
      runs: runs.length,
      activeRuns: activeRuns.length,
      tasks: tasks.length,
      activeTasks: activeTasks.length,
      queuedTasks: tasks.filter(({ task }) => isQueuedTask(task)).length,
      runningTasks: tasks.filter(({ task }) => isRunningTask(task)).length,
      attentionTasks: tasks.filter(({ task }) => isAttentionTask(task)).length,
      readyTasks: tasks.filter(({ task }) => isReadyTask(task)).length,
      runStatuses: countBy(runs, (run) => run.status),
      taskStatuses: countBy(tasks, ({ task }) => task.status),
      boardStatuses: countBy(tasks, ({ task }) => task.statusCategory),
    },
  };
}

function asTuiState(statusData, options = {}) {
  if (statusData?.kind === "pi-multitask-tui-state") return statusData;
  return createTuiState(statusData, options);
}

function formatCountParts(runOrCounts, options = {}) {
  const counts = runOrCounts || {};
  const parts = [];
  const includeZero = options.includeZero === true;
  const pairs = [
    ["queuedTaskCount", "queued"],
    ["runningTaskCount", "running"],
    ["attentionTaskCount", "attention"],
    ["readyTaskCount", "ready"],
  ];
  for (const [key, label] of pairs) {
    const count = numeric(counts[key]) ?? 0;
    if (count > 0 || includeZero) parts.push(`${count} ${label}`);
  }
  return parts;
}

function formatRunCounts(run, options = {}) {
  const parts = formatCountParts(run, options);
  return parts.length ? parts.join(" · ") : "no active tasks";
}

function formatRunHeader(run, options = {}) {
  const name = options.useId ? run.runId : run.displayName;
  return `run ${name} · ${formatRunCounts(run, options)}`;
}

function formatTaskSummary(task, options = {}) {
  const status = options.compact === false ? task.statusLabel : task.compactStatusLabel;
  const activity = task.workerActivity && task.workerActivity !== task.status ? ` (${formatStatus(task.workerActivity, { compact: true })})` : "";
  return `${task.id} ${status}${activity}`;
}

function formatRunTaskSummary(run, options = {}) {
  const maxTasks = options.maxTasks ?? 4;
  const tasks = run.tasks || [];
  if (!tasks.length) return "no tasks";
  const shown = tasks.slice(0, maxTasks).map((task) => formatTaskSummary(task, { compact: true }));
  if (tasks.length > shown.length) shown.push(`+${tasks.length - shown.length} more`);
  return shown.join(" · ");
}

function chooseWidgetRuns(state, options = {}) {
  if (options.includeInactive) return state.runs;
  if (state.activeRuns.length) return state.activeRuns;
  return [];
}

function formatCompactWidgetLines(statusData, options = {}) {
  const state = asTuiState(statusData, options);
  const runs = chooseWidgetRuns(state, options);
  if (!runs.length) return options.emptyLines || [];
  const maxRuns = options.maxRuns ?? 2;
  const width = options.width || 120;
  const lines = [];
  if (runs.length === 1) {
    lines.push(`porchestrator: ${formatRunHeader(runs[0], options)}`);
  } else {
    const counts = runs.reduce((sum, run) => ({
      queuedTaskCount: sum.queuedTaskCount + run.queuedTaskCount,
      runningTaskCount: sum.runningTaskCount + run.runningTaskCount,
      attentionTaskCount: sum.attentionTaskCount + run.attentionTaskCount,
      readyTaskCount: sum.readyTaskCount + run.readyTaskCount,
    }), { queuedTaskCount: 0, runningTaskCount: 0, attentionTaskCount: 0, readyTaskCount: 0 });
    lines.push(`porchestrator: ${plural(runs.length, "run")} · ${formatRunCounts(counts)}`);
  }
  for (const run of runs.slice(0, maxRuns)) {
    const summary = formatRunTaskSummary(run, { maxTasks: options.maxTasksPerRun ?? 4 });
    lines.push(`  ${run.displayName}: ${summary}`);
  }
  if (runs.length > maxRuns) lines.push(`  +${runs.length - maxRuns} more ${runs.length - maxRuns === 1 ? "run" : "runs"}`);
  return lines.map((line) => truncatePlain(line, width));
}

function formatStatusIndicator(statusData, options = {}) {
  const state = asTuiState(statusData, options);
  const runs = chooseWidgetRuns(state, options);
  if (!runs.length) return undefined;
  const text = runs.length === 1
    ? `porchestrator: ${formatRunHeader(runs[0], options)}`
    : `porchestrator: ${plural(runs.length, "run")} · ${formatRunCounts(runs.reduce((sum, run) => ({
        queuedTaskCount: sum.queuedTaskCount + run.queuedTaskCount,
        runningTaskCount: sum.runningTaskCount + run.runningTaskCount,
        attentionTaskCount: sum.attentionTaskCount + run.attentionTaskCount,
        readyTaskCount: sum.readyTaskCount + run.readyTaskCount,
      }), { queuedTaskCount: 0, runningTaskCount: 0, attentionTaskCount: 0, readyTaskCount: 0 }))}`;
  return truncatePlain(text, options.width || 120);
}

function formatActiveRuns(statusData, options = {}) {
  const state = asTuiState(statusData, options);
  const runs = options.includeInactive ? state.runs : state.activeRuns;
  if (!runs.length) return "No active Porchestrator runs.";
  const lines = [];
  for (const run of runs) {
    lines.push(`${run.displayName}: ${run.statusLabel} (${formatRunCounts(run)})`);
    for (const task of run.tasks || []) lines.push(`- ${formatTaskSummary(task, { compact: false })}`);
  }
  return lines.join("\n");
}

function formatTaskCard(task, options = {}) {
  const prefix = options.selected ? "> " : "  ";
  const idWidth = options.idWidth ?? 12;
  const statusWidth = options.statusWidth ?? 18;
  const attachment = task.workerAttachment ? ` · ${formatStatus(task.workerAttachment, { compact: true })}` : "";
  const detail = task.changedFilesText || task.branch || task.workerActivity || "";
  return `${prefix}${pad(task.id, idWidth)} ${pad(task.statusLabel, statusWidth)} ${detail}${attachment}`.trimEnd();
}

function formatEventLine(event) {
  if (!event) return "";
  const time = event.time ? String(event.time).replace(/^\d{4}-\d{2}-\d{2}T/, "").replace(/\.\d{3}Z$/, "Z") : "";
  const label = event.type || event.kind || event.direction || "event";
  const detail = event.error || event.status || event.command?.type || event.command || event.message || event.path || event.tool || event.summary || "";
  return `${time ? `${time} ` : ""}${label}${detail ? ` ${detail}` : ""}`.trim();
}

function formatMessageCounts(counts) {
  if (!counts || typeof counts !== "object") return undefined;
  const entries = Object.entries(counts).filter(([, count]) => Number(count) > 0);
  if (!entries.length) return undefined;
  return entries.map(([type, count]) => `${count} ${formatStatus(type, { compact: true })}`).join(" · ");
}

function formatTaskDetail(task, run, options = {}) {
  const eventLimit = options.eventLimit ?? 5;
  const events = (task.lastEvents || []).slice(-eventLimit);
  const lines = [
    task.title ? `${task.id} — ${task.title}` : task.id,
    `status: ${task.statusLabel}`,
  ];
  if (task.statusCategory) lines.push(`board: ${BOARD_LABELS[task.statusCategory] || task.statusCategory}`);
  if (task.workerActivity || task.workerAttachment) {
    lines.push(`worker: ${[task.workerActivity, task.workerAttachment].filter(Boolean).map((part) => formatStatus(part)).join(" · ")}`);
  }
  if (task.worktree) lines.push(`worktree: ${task.worktree}`);
  if (task.branch) lines.push(`branch: ${task.branch}`);
  if (run?.displayName) lines.push(`run: ${run.displayName}`);
  if (task.changedFilesText) lines.push(`changes: ${task.changedFilesText}`);
  if (task.error) lines.push(`attention/error: ${task.error}`);
  const counts = formatMessageCounts(task.messageCounts);
  if (counts) lines.push(`messages: ${counts}`);
  if (task.lastMessageAt) lines.push(`last message: ${task.lastMessageAt}`);
  if (task.review?.decision) lines.push(`review: ${formatStatus(task.review.decision)}${task.review.reviewedAt ? ` at ${task.review.reviewedAt}` : ""}`);
  lines.push("", "Last events:");
  if (!events.length) lines.push("- No recent events recorded.");
  for (const event of events) lines.push(`- ${formatEventLine(event)}`);
  lines.push("", "Views: [b] board  [i] detail  [t] transcript tail  [d] diff  [v] review  [g] integration");
  lines.push("Actions: [m] message  [s] steer  [x] abort  [R] review  [M] merge  [a] apply  [c] cleanup  [u] refresh  [q] close");
  return lines;
}

function formatChangedFileLine(file) {
  if (typeof file === "string") return file;
  if (!file || typeof file !== "object") return String(file || "");
  const rename = file.oldPath ? ` (from ${file.oldPath})` : "";
  return [file.status, file.path || file.file || file.name].filter(Boolean).join(" ") + rename;
}

function formatDiffSummaryLines(task, options = {}) {
  const maxFiles = options.maxFiles ?? 20;
  const lines = [`Diff summary: ${task.id}`, ""];
  const diff = task.diff || {};
  const summary = task.diffSummary || diff.summary || task.changedFilesText;
  if (summary) lines.push(summary);
  const files = getChangedFiles(task);
  if (!files.length) {
    lines.push("No changed-file summary is available yet. Use [D] to run multitask_diff for a fresh summary.");
  } else {
    lines.push("Changed files:");
    for (const file of files.slice(0, maxFiles)) lines.push(`- ${formatChangedFileLine(file)}`);
    if (files.length > maxFiles) lines.push(`- … ${files.length - maxFiles} more file(s)`);
  }
  if (diff.shortstat) lines.push("", `shortstat: ${diff.shortstat}`);
  if (diff.errors?.length) lines.push("", "Diff warnings:", ...diff.errors.slice(0, 5).map((error) => `- ${error}`));
  lines.push("", "Full patches are intentionally not rendered here; this view stays bounded for TUI inspection.");
  return lines;
}

function checkOk(check) {
  if (check?.ok === true || check?.status === "passed") return "✓";
  if (check?.ok === false || check?.status === "failed") return "✗";
  return "•";
}

function formatReviewResultsLines(task, options = {}) {
  const review = task.review || {};
  const lines = [`Review results: ${task.id}`, ""];
  if (!Object.keys(review).length) {
    lines.push("No review result recorded yet. Press [R] to run multitask_review for the selected task.");
    return lines;
  }
  if (review.decision) lines.push(`decision: ${formatStatus(review.decision)}`);
  if (review.reviewedAt) lines.push(`reviewed: ${review.reviewedAt}`);
  if (review.reviewPath) lines.push(`path: ${review.reviewPath}`);
  if (review.noCredit !== undefined) lines.push(`no-credit deterministic: ${review.noCredit ? "yes" : "no"}`);
  if (review.ai?.status || review.aiReview?.status) {
    const ai = review.ai || review.aiReview;
    lines.push(`AI review: ${ai.status}${ai.creditConsuming ? " · credit-consuming" : " · no credits"}`);
    if (ai.summary) lines.push(`AI summary: ${ai.summary}`);
    if (Array.isArray(ai.actionableFindings) && ai.actionableFindings.length) {
      lines.push("AI findings:");
      for (const finding of ai.actionableFindings.slice(0, options.maxFindings ?? 5)) {
        lines.push(`- ${finding.file ? `${finding.file}: ` : ""}${finding.summary || finding.message || JSON.stringify(finding)}`);
      }
    }
  }
  const checks = Array.isArray(review.checks) ? review.checks : Array.isArray(review.deterministic?.checks) ? review.deterministic.checks : [];
  if (checks.length) {
    lines.push("", "Checks:");
    for (const check of checks.slice(0, options.maxChecks ?? 12)) {
      lines.push(`- ${checkOk(check)} ${check.name || check.id || "check"}${check.summary ? ` — ${check.summary}` : ""}`);
    }
    if (checks.length > (options.maxChecks ?? 12)) lines.push(`- … ${checks.length - (options.maxChecks ?? 12)} more check(s)`);
  }
  const feedback = review.feedback?.dto || review.feedback;
  if (feedback?.text || feedback?.summary) lines.push("", `Feedback: ${feedback.text || feedback.summary}`);
  return lines;
}

function transcriptText(entry) {
  if (!entry) return "";
  if (typeof entry === "string") return entry;
  if (entry.text) return entry.text;
  if (entry.message) return typeof entry.message === "string" ? entry.message : entry.message.content || entry.message.text || JSON.stringify(entry.message);
  if (entry.command) return typeof entry.command === "string" ? entry.command : [entry.command.type, entry.command.message].filter(Boolean).join(" ");
  if (entry.event) return typeof entry.event === "string" ? entry.event : JSON.stringify(entry.event);
  if (entry.response) return typeof entry.response === "string" ? entry.response : JSON.stringify(entry.response);
  return entry.summary || entry.type || entry.kind || JSON.stringify(entry);
}

function formatTranscriptLine(entry, options = {}) {
  const maxWidth = options.maxWidth ?? 140;
  const time = entry?.time ? String(entry.time).replace(/^\d{4}-\d{2}-\d{2}T/, "").replace(/\.\d{3}Z$/, "Z") : "";
  const label = entry?.role || entry?.direction || entry?.kind || entry?.type || "entry";
  const text = truncatePlain(String(transcriptText(entry)).replace(/\s+/g, " ").trim(), maxWidth);
  return `${time ? `${time} ` : ""}${label}: ${text}`.trim();
}

function formatTranscriptTailLines(task, options = {}) {
  const maxEntries = options.maxEntries ?? 20;
  const transcript = (task.transcriptTail || task.transcript || []).slice(-maxEntries);
  const lines = [`Transcript tail: ${task.id}`, "", `Showing last ${transcript.length} entr${transcript.length === 1 ? "y" : "ies"} only. Full logs are not dumped into model context.`];
  if (!transcript.length) {
    lines.push("", "No transcript tail is available yet. Refresh with [u] after worker activity.");
    return lines;
  }
  lines.push("");
  for (const entry of transcript) lines.push(`- ${formatTranscriptLine(entry, options)}`);
  return lines;
}

function formatValidationLines(validation, label = "Validation") {
  if (!validation) return [];
  const items = Array.isArray(validation) ? validation : [validation];
  const lines = [label + ":"];
  for (const item of items) {
    if (!item || typeof item !== "object") lines.push(`- ${String(item)}`);
    else lines.push(`- ${item.status || (item.ok ? "passed" : "failed")} ${item.id || item.name || item.command || "validation"}${item.summary ? ` — ${item.summary}` : ""}`);
  }
  return lines;
}

function formatIntegrationStatusLines(run, options = {}) {
  const integration = run?.integration || {};
  const lines = [`Integration: ${run?.displayName || run?.runId || "run"}`, ""];
  if (!Object.keys(integration).length) {
    lines.push("No integration worktree is configured for this run.");
    return lines;
  }
  lines.push(`status: ${formatStatus(integration.status || "unknown")}`);
  if (integration.branch) lines.push(`branch: ${integration.branch}`);
  if (integration.worktree) lines.push(`worktree: ${integration.worktree}`);
  if (integration.error) lines.push(`error: ${integration.error}`);
  if (Array.isArray(integration.merges) && integration.merges.length) {
    lines.push("", "Merges:");
    for (const merge of integration.merges.slice(0, options.maxMerges ?? 12)) {
      lines.push(`- ${merge.taskId || merge.id || "task"}: ${merge.status || "unknown"}${merge.commit ? ` @ ${String(merge.commit).slice(0, 12)}` : ""}`);
    }
  }
  const validationLines = formatValidationLines(integration.validation, "Validation");
  if (validationLines.length) lines.push("", ...validationLines);
  if (integration.apply) {
    lines.push("", `Apply: ${integration.apply.status || "unknown"}${integration.apply.appliedAt ? ` at ${integration.apply.appliedAt}` : ""}`);
  }
  return lines;
}

function groupTasksForBoard(run) {
  const groups = new Map();
  for (const key of BOARD_ORDER) groups.set(key, []);
  for (const task of run.tasks || []) {
    const key = groups.has(task.statusCategory) ? task.statusCategory : "other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }
  return groups;
}

function formatTaskBoardLines(statusData, options = {}) {
  const state = asTuiState(statusData, options);
  const runs = options.includeInactive ? state.runs : state.activeRuns.length ? state.activeRuns : state.runs;
  const selectedKey = options.selectedKey;
  const lines = ["Task board", ""];
  if (!runs.length) {
    lines.push("No Porchestrator runs found.");
    return lines;
  }
  for (const run of runs.slice(0, options.maxRuns ?? 3)) {
    lines.push(`Run: ${run.displayName} · ${run.statusLabel} · ${formatRunCounts(run)}`);
    const groups = groupTasksForBoard(run);
    let wroteGroup = false;
    for (const [group, tasks] of groups) {
      if (!tasks.length) continue;
      wroteGroup = true;
      lines.push(`  ${BOARD_LABELS[group] || group} (${tasks.length})`);
      for (const task of tasks.slice(0, options.maxTasksPerGroup ?? 8)) {
        lines.push(formatTaskCard(task, { selected: selectedKey === `${run.runId}/${task.id}` }));
      }
      if (tasks.length > (options.maxTasksPerGroup ?? 8)) lines.push(`    +${tasks.length - (options.maxTasksPerGroup ?? 8)} more`);
    }
    if (!wroteGroup) lines.push("  no tasks");
    lines.push("");
  }
  return lines;
}

function formatRunsListLines(statusData, options = {}) {
  const state = asTuiState(statusData, options);
  const runs = options.includeInactive ? state.runs : state.activeRuns.length ? state.activeRuns : state.runs;
  const lines = ["Runs", ""];
  if (!runs.length) {
    lines.push("No Porchestrator runs found.");
    return lines;
  }
  for (const run of runs.slice(0, options.maxRuns ?? 20)) {
    const selected = options.selectedRunId === run.runId ? "> " : "  ";
    lines.push(`${selected}${run.displayName} · ${run.statusLabel} · ${formatRunCounts(run)}`);
    if (run.baseBranch || run.baseRef) lines.push(`    base: ${[run.baseBranch, run.baseRef].filter(Boolean).join(" @ ")}`);
    if (run.maxConcurrency) lines.push(`    concurrency: ${run.runningTaskCount}/${run.maxConcurrency}`);
    if (run.integration?.status) lines.push(`    integration: ${formatStatus(run.integration.status)}`);
  }
  return lines;
}

function findTask(stateOrData, runId, taskId) {
  const state = asTuiState(stateOrData);
  for (const run of state.runs) {
    if (run.runId !== runId) continue;
    const task = (run.tasks || []).find((candidate) => candidate.id === taskId);
    if (task) return { run, task };
  }
  return undefined;
}

function formatPanelLines(statusData, options = {}) {
  const state = asTuiState(statusData, options);
  const view = options.view || "board";
  const lines = ["Porchestrator", ""];
  if (view === "runs") lines.push(...formatRunsListLines(state, options));
  else if (view === "task" && options.runId && options.taskId) {
    const found = findTask(state, options.runId, options.taskId);
    if (found) lines.push(...formatTaskDetail(found.task, found.run, options));
    else lines.push(`Task not found: ${options.runId}/${options.taskId}`);
  } else if (view === "transcript" && options.runId && options.taskId) {
    const found = findTask(state, options.runId, options.taskId);
    if (found) lines.push(...formatTranscriptTailLines(found.task, options));
    else lines.push(`Task not found: ${options.runId}/${options.taskId}`);
  } else if (view === "diff" && options.runId && options.taskId) {
    const found = findTask(state, options.runId, options.taskId);
    if (found) lines.push(...formatDiffSummaryLines(found.task, options));
    else lines.push(`Task not found: ${options.runId}/${options.taskId}`);
  } else if (view === "review" && options.runId && options.taskId) {
    const found = findTask(state, options.runId, options.taskId);
    if (found) lines.push(...formatReviewResultsLines(found.task, options));
    else lines.push(`Task not found: ${options.runId}/${options.taskId}`);
  } else if (view === "integration") {
    const run = state.runs.find((candidate) => candidate.runId === options.runId) || state.runs[0];
    if (run) lines.push(...formatIntegrationStatusLines(run, options));
    else lines.push("No run selected.");
  } else {
    lines.push(...formatTaskBoardLines(state, options));
  }
  lines.push("", "b board · l runs · i detail · t transcript · d diff · v review · g integration · u refresh · q close");
  return lines;
}

async function loadTuiState(repoRoot, options = {}) {
  const { listRuns, loadManifest } = require("./manifest.js");
  const { readTaskEvents, readTranscript } = require("./events.js");
  const eventLimit = options.eventLimit ?? 0;
  const transcriptLimit = options.transcriptLimit ?? 0;
  const manifests = options.runId ? [await loadManifest(repoRoot, options.runId)] : await listRuns(repoRoot);
  const runs = [];
  for (const manifest of manifests) {
    const tasks = [];
    for (const task of manifest.tasks || []) {
      let lastEvents = [];
      let transcriptTail = [];
      if (eventLimit > 0) {
        lastEvents = await readTaskEvents(repoRoot, manifest.runId, task.id, { lines: eventLimit }).catch(() => []);
      }
      if (transcriptLimit > 0) {
        transcriptTail = await readTranscript(repoRoot, manifest.runId, task.id, { lines: transcriptLimit }).catch(() => []);
      }
      tasks.push({ ...task, lastEvents, transcriptTail });
    }
    runs.push({ ...manifest, tasks });
  }
  return createTuiState({ runs }, options);
}

module.exports = {
  ATTENTION_TASK_STATES,
  BOARD_LABELS,
  BOARD_ORDER,
  QUEUED_TASK_STATES,
  READY_TASK_STATES,
  RUNNING_TASK_STATES,
  TERMINAL_RUN_STATES,
  TERMINAL_TASK_STATES,
  asTuiState,
  createTuiState,
  findTask,
  formatActiveRuns,
  formatChangedFileLine,
  formatChangedFiles,
  formatCompactWidgetLines,
  formatDiffSummaryLines,
  formatEventLine,
  formatIntegrationStatusLines,
  formatPanelLines,
  formatReviewResultsLines,
  formatRunCounts,
  formatRunHeader,
  formatRunTaskSummary,
  formatRunsListLines,
  formatStatus,
  formatStatusIndicator,
  formatTaskBoardLines,
  formatTaskCard,
  formatTaskDetail,
  formatTaskSummary,
  formatTranscriptLine,
  formatTranscriptTailLines,
  isActiveRun,
  isActiveTask,
  isAttentionTask,
  isQueuedTask,
  isReadyTask,
  isRunningTask,
  isTerminalRun,
  isTerminalTask,
  loadTuiState,
  normalizeRun,
  normalizeStatusInput,
  normalizeTask,
  truncatePlain,
};
