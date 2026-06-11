const { ensureDir, fsp, path, pathExists } = require("../utils.js");
const {
  runDir,
  runEventsPath,
  taskDir,
  taskEventsPath,
  taskTranscriptPath,
} = require("./manifest.js");

function createEvent(type, data = {}, context = {}) {
  if (!type || typeof type !== "string") throw new Error("Porchestrator event type is required.");
  return {
    time: new Date().toISOString(),
    type,
    runId: context.runId,
    taskId: context.taskId,
    scope: context.taskId ? "task" : "run",
    ...data,
  };
}

async function appendJsonLine(file, value) {
  await ensureDir(path.dirname(file));
  await fsp.appendFile(file, JSON.stringify(value) + "\n", "utf8");
  return value;
}

async function appendRunEvent(repoRoot, runId, type, data = {}) {
  return appendJsonLine(runEventsPath(repoRoot, runId), createEvent(type, data, { runId }));
}

async function appendTaskEvent(repoRoot, runId, taskId, type, data = {}) {
  const event = createEvent(type, data, { runId, taskId });
  await appendJsonLine(taskEventsPath(repoRoot, runId, taskId), event);
  await appendJsonLine(runEventsPath(repoRoot, runId), event);
  return event;
}

async function appendTranscriptEvent(repoRoot, runId, taskId, event) {
  const entry = {
    time: new Date().toISOString(),
    runId,
    taskId,
    ...event,
  };
  return appendJsonLine(taskTranscriptPath(repoRoot, runId, taskId), entry);
}

function parseJsonLine(line, source) {
  try {
    return JSON.parse(line);
  } catch (error) {
    return {
      time: new Date().toISOString(),
      type: "malformed_event",
      source,
      raw: line,
      error: error.message,
    };
  }
}

async function readJsonLines(file, options = {}) {
  if (!(await pathExists(file))) return [];
  const raw = await fsp.readFile(file, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  const limit = Number(options.limit || options.lines || 0);
  const selected = limit > 0 ? lines.slice(-limit) : lines;
  return selected.map((line) => parseJsonLine(line, file));
}

async function readRunEvents(repoRoot, runId, options = {}) {
  return readJsonLines(runEventsPath(repoRoot, runId), options);
}

async function readTaskEvents(repoRoot, runId, taskId, options = {}) {
  return readJsonLines(taskEventsPath(repoRoot, runId, taskId), options);
}

async function readTranscript(repoRoot, runId, taskId, options = {}) {
  return readJsonLines(taskTranscriptPath(repoRoot, runId, taskId), options);
}

async function initializeEventFiles(repoRoot, manifest) {
  await ensureDir(runDir(repoRoot, manifest.runId));
  await appendRunEvent(repoRoot, manifest.runId, "run_created", {
    status: manifest.status,
    baseRef: manifest.baseRef,
    baseCommit: manifest.baseCommit,
  });
  for (const task of manifest.tasks || []) {
    await ensureDir(taskDir(repoRoot, manifest.runId, task.id));
    await appendTaskEvent(repoRoot, manifest.runId, task.id, "task_created", {
      status: task.status,
      branch: task.branch,
      worktree: task.worktree,
    });
  }
}

module.exports = {
  appendJsonLine,
  appendRunEvent,
  appendTaskEvent,
  appendTranscriptEvent,
  createEvent,
  initializeEventFiles,
  readJsonLines,
  readRunEvents,
  readTaskEvents,
  readTranscript,
};
