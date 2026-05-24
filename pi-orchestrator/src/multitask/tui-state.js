const TERMINAL_RUN_STATES = new Set(["merged", "failed", "cancelled"]);
const TERMINAL_TASK_STATES = new Set(["merged", "failed", "cancelled"]);
const ATTENTION_TASK_STATES = new Set(["needs_attention", "validation_failed", "needs_changes", "failed"]);
const READY_TASK_STATES = new Set(["ready_for_review", "ready_to_merge"]);

const STATUS_LABELS = Object.freeze({
  creating_worktree: "creating worktree",
  needs_attention: "needs attention",
  ready_for_review: "ready for review",
  validation_failed: "validation failed",
  ready_to_merge: "ready to merge",
});

const COMPACT_STATUS_LABELS = Object.freeze({
  creating_worktree: "creating",
  needs_attention: "attention",
  ready_for_review: "ready review",
  validation_failed: "validation failed",
  ready_to_merge: "ready merge",
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
  return ATTENTION_TASK_STATES.has(String(task?.status || ""));
}

function isReadyTask(task) {
  return READY_TASK_STATES.has(String(task?.status || ""));
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
  if (input.kind === "pi-multitask-run" || input.runId) return [input];
  return [];
}

function countBy(items, getKey) {
  const counts = {};
  for (const item of items || []) {
    const key = getKey(item) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function changedFilesCount(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.length;
  return undefined;
}

function getChangedFilesCount(task) {
  return changedFilesCount(task?.changedFiles) ??
    changedFilesCount(task?.filesChanged) ??
    changedFilesCount(task?.diff?.changedFiles) ??
    changedFilesCount(task?.diff?.files) ??
    changedFilesCount(task?.summary?.changedFiles);
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

function normalizeTask(task = {}, run) {
  const status = task.status || "unknown";
  const taskId = task.id || task.taskId || "task";
  return {
    ...task,
    id: taskId,
    runId: run?.runId,
    status,
    statusLabel: formatStatus(status),
    compactStatusLabel: formatStatus(status, { compact: true }),
    title: task.title,
    branch: task.branch,
    worktree: task.worktree,
    workerActivity: workerActivity(task),
    changedFilesText: formatChangedFiles(task),
    attention: isAttentionTask(task),
    ready: isReadyTask(task),
    active: isActiveTask(task),
    lastEvents: Array.isArray(task.lastEvents) ? task.lastEvents : Array.isArray(task.events) ? task.events : [],
  };
}

function normalizeRun(run = {}) {
  const status = run.status || "unknown";
  const tasks = (run.tasks || []).map((task) => normalizeTask(task, run));
  const displayName = run.runName || run.name || run.runId || "multitask";
  return {
    ...run,
    runId: run.runId || run.id || displayName,
    runName: run.runName || run.name,
    displayName,
    status,
    statusLabel: formatStatus(status),
    compactStatusLabel: formatStatus(status, { compact: true }),
    tasks,
    active: isActiveRun({ status }),
    taskCounts: countBy(tasks, (task) => task.status),
    activeTaskCount: tasks.filter(isActiveTask).length,
    attentionTaskCount: tasks.filter(isAttentionTask).length,
    readyTaskCount: tasks.filter(isReadyTask).length,
  };
}

function createTuiState(statusData, options = {}) {
  const runs = normalizeStatusInput(statusData).map(normalizeRun);
  const activeRuns = runs.filter(isActiveRun);
  const tasks = runs.flatMap((run) => run.tasks.map((task) => ({ run, task })));
  const activeTasks = tasks.filter(({ task }) => isActiveTask(task));
  return {
    kind: "pi-multitask-tui-state",
    generatedAt: options.now || new Date().toISOString(),
    runs,
    activeRuns,
    totals: {
      runs: runs.length,
      activeRuns: activeRuns.length,
      tasks: tasks.length,
      activeTasks: activeTasks.length,
      attentionTasks: tasks.filter(({ task }) => isAttentionTask(task)).length,
      readyTasks: tasks.filter(({ task }) => isReadyTask(task)).length,
      runStatuses: countBy(runs, (run) => run.status),
      taskStatuses: countBy(tasks, ({ task }) => task.status),
    },
  };
}

function asTuiState(statusData, options = {}) {
  if (statusData?.kind === "pi-multitask-tui-state") return statusData;
  return createTuiState(statusData, options);
}

function formatTaskSummary(task, options = {}) {
  const status = options.compact === false ? task.statusLabel : task.compactStatusLabel;
  const activity = task.workerActivity && task.workerActivity !== task.status ? ` (${task.workerActivity})` : "";
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

function formatCompactWidgetLines(statusData, options = {}) {
  const state = asTuiState(statusData, options);
  const runs = options.includeInactive ? state.runs : state.activeRuns;
  if (!runs.length) return options.emptyLines || [];
  const maxRuns = options.maxRuns ?? 2;
  const width = options.width || 120;
  const title = options.includeInactive
    ? `Multitask: ${plural(runs.length, "run")}`
    : `Multitask: ${plural(runs.length, "run")} active`;
  const lines = [title];
  for (const run of runs.slice(0, maxRuns)) {
    const summary = formatRunTaskSummary(run, { maxTasks: options.maxTasksPerRun ?? 4 });
    lines.push(`  ${run.displayName}: ${summary}`);
  }
  if (runs.length > maxRuns) lines.push(`  +${runs.length - maxRuns} more ${runs.length - maxRuns === 1 ? "run" : "runs"}`);
  return lines.map((line) => truncatePlain(line, width));
}

function formatStatusIndicator(statusData, options = {}) {
  const state = asTuiState(statusData, options);
  if (!state.activeRuns.length) return undefined;
  const workerCount = state.activeRuns.reduce((sum, run) => sum + run.tasks.filter(isActiveTask).length, 0);
  if (workerCount > 0) return `mt: ${plural(workerCount, "worker")}`;
  return `mt: ${plural(state.activeRuns.length, "run")}`;
}

function formatActiveRuns(statusData, options = {}) {
  const state = asTuiState(statusData, options);
  const runs = options.includeInactive ? state.runs : state.activeRuns;
  if (!runs.length) return "No active multitask runs.";
  const lines = [];
  for (const run of runs) {
    lines.push(`${run.displayName}: ${run.statusLabel}`);
    for (const task of run.tasks || []) lines.push(`- ${formatTaskSummary(task, { compact: false })}`);
  }
  return lines.join("\n");
}

function formatTaskCard(task, options = {}) {
  const prefix = options.selected ? "> " : "  ";
  const idWidth = options.idWidth ?? 12;
  const statusWidth = options.statusWidth ?? 18;
  const detail = task.changedFilesText || task.branch || task.workerActivity || "";
  return `${prefix}${pad(task.id, idWidth)} ${pad(task.statusLabel, statusWidth)} ${detail}`.trimEnd();
}

function formatEventLine(event) {
  if (!event) return "";
  const time = event.time ? String(event.time).replace(/^\d{4}-\d{2}-\d{2}T/, "").replace(/\.\d{3}Z$/, "Z") : "";
  const label = event.type || event.kind || event.direction || "event";
  const detail = event.error || event.status || event.command || event.message || event.path || event.tool || "";
  return `${time ? `${time} ` : ""}${label}${detail ? ` ${detail}` : ""}`.trim();
}

function formatTaskDetail(task, run, options = {}) {
  const eventLimit = options.eventLimit ?? 5;
  const events = (task.lastEvents || []).slice(-eventLimit);
  const lines = [
    task.title ? `${task.id} — ${task.title}` : task.id,
    `status: ${task.statusLabel}`,
  ];
  if (task.workerActivity) lines.push(`worker: ${task.workerActivity}`);
  if (task.worktree) lines.push(`worktree: ${task.worktree}`);
  if (task.branch) lines.push(`branch: ${task.branch}`);
  if (run?.displayName) lines.push(`run: ${run.displayName}`);
  if (task.changedFilesText) lines.push(`changes: ${task.changedFilesText}`);
  if (task.error) lines.push(`error: ${task.error}`);
  lines.push("", "Last events:");
  if (!events.length) lines.push("- No recent events recorded.");
  for (const event of events) lines.push(`- ${formatEventLine(event)}`);
  lines.push("", "Actions:", "[m] send message  [d] diff  [r] review  [x] cancel  [q] close");
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
  const runs = options.includeInactive ? state.runs : state.activeRuns.length ? state.activeRuns : state.runs;
  const lines = ["Pi Multitask", ""];
  if (!runs.length) {
    lines.push("No multitask runs found.", "", "q close");
    return lines;
  }

  const selectedKey = options.selectedKey;
  for (const run of runs.slice(0, options.maxRuns ?? 3)) {
    lines.push(`Run: ${run.displayName}                         status: ${run.statusLabel}`);
    if (!run.tasks.length) lines.push("  no tasks");
    for (const task of run.tasks.slice(0, options.maxTasksPerRun ?? 12)) {
      lines.push(formatTaskCard(task, { selected: selectedKey === `${run.runId}/${task.id}` }));
    }
    lines.push("");
  }
  lines.push("enter inspect · m message · d diff · r review · x cancel · q close");
  return lines;
}

async function loadTuiState(repoRoot, options = {}) {
  const { listRuns, loadManifest } = require("./manifest.js");
  const { readTaskEvents } = require("./events.js");
  const eventLimit = options.eventLimit ?? 0;
  const manifests = options.runId ? [await loadManifest(repoRoot, options.runId)] : await listRuns(repoRoot);
  const runs = [];
  for (const manifest of manifests) {
    const tasks = [];
    for (const task of manifest.tasks || []) {
      let lastEvents = [];
      if (eventLimit > 0) {
        lastEvents = await readTaskEvents(repoRoot, manifest.runId, task.id, { lines: eventLimit }).catch(() => []);
      }
      tasks.push({ ...task, lastEvents });
    }
    runs.push({ ...manifest, tasks });
  }
  return createTuiState({ runs }, options);
}

module.exports = {
  ATTENTION_TASK_STATES,
  READY_TASK_STATES,
  TERMINAL_RUN_STATES,
  TERMINAL_TASK_STATES,
  asTuiState,
  createTuiState,
  findTask,
  formatActiveRuns,
  formatChangedFiles,
  formatCompactWidgetLines,
  formatEventLine,
  formatPanelLines,
  formatRunTaskSummary,
  formatStatus,
  formatStatusIndicator,
  formatTaskCard,
  formatTaskDetail,
  formatTaskSummary,
  isActiveRun,
  isActiveTask,
  isAttentionTask,
  isReadyTask,
  isTerminalRun,
  isTerminalTask,
  loadTuiState,
  normalizeRun,
  normalizeStatusInput,
  normalizeTask,
  truncatePlain,
};
