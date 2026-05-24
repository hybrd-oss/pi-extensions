const { branchExists, getRepoInfo } = require("../git.js");
const { ensureDir, fsp, path, pathExists, slugify } = require("../utils.js");
const { appendTaskEvent } = require("./events.js");
const {
  loadManifest,
  saveManifest,
  saveTaskState,
  taskReviewPath,
} = require("./manifest.js");
const { getTaskDiff } = require("./diff.js");

const REVIEWABLE_STATUSES = new Set([
  "idle",
  "needs_attention",
  "validation_failed",
  "ready_for_review",
  "needs_changes",
  "ready_to_merge",
]);

const TERMINAL_STATUSES = new Set(["merged", "cancelled"]);

function selectTask(manifest, taskId) {
  const normalized = slugify(taskId, "task");
  const task = (manifest.tasks || []).find((candidate) => candidate.id === normalized || candidate.id === taskId);
  if (!task) throw new Error(`No multitask task ${taskId} in run ${manifest.runId}.`);
  return task;
}

function validationFailures(task) {
  return (task.validation || []).filter((result) => result?.status === "failed" && result.required !== false);
}

function addCheck(checks, name, ok, details, blocking = true) {
  const check = { name, ok: Boolean(ok), blocking: blocking !== false };
  if (details !== undefined) check.details = details;
  checks.push(check);
  return check;
}

function hasBlockingFailures(checks) {
  return checks.some((check) => check.blocking !== false && !check.ok);
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function scanConflictMarkers(task, diff) {
  const findings = [];
  if (!task.worktree || !(await pathExists(task.worktree))) return findings;
  for (const file of diff.changedFiles || []) {
    if (!file.path) continue;
    const absolute = path.resolve(task.worktree, file.path);
    if (!isPathInside(task.worktree, absolute) && absolute !== task.worktree) continue;
    let stat;
    try {
      stat = await fsp.stat(absolute);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > 1024 * 1024) continue;
    const buffer = await fsp.readFile(absolute);
    if (buffer.includes(0)) continue;
    const text = buffer.toString("utf8");
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      if (/^(<<<<<<<|=======|>>>>>>>)(\s|$)/.test(lines[index])) {
        findings.push({ path: file.path, line: index + 1, marker: lines[index].slice(0, 40) });
      }
    }
  }
  return findings;
}

function formatReviewMarkdown({ manifest, task, diff, checks, decision }) {
  const lines = [
    `# Multitask Review: ${manifest.runId}/${task.id}`,
    "",
    `Decision: **${decision}**`,
    `Reviewed at: ${new Date().toISOString()}`,
    `Branch: ${task.branch || "(none)"}`,
    `Worktree: ${task.worktree || "(none)"}`,
    `Changed files: ${diff.changedFiles.length}`,
    "",
    "## Deterministic Checks",
  ];
  for (const check of checks) {
    const marker = check.ok ? "pass" : check.blocking === false ? "warn" : "fail";
    lines.push(`- [${marker}] ${check.name}${check.details === undefined ? "" : ` — ${typeof check.details === "string" ? check.details : JSON.stringify(check.details)}`}`);
  }
  lines.push("", "## Changed Files");
  if (!diff.changedFiles.length) lines.push("No changed files detected.");
  else {
    for (const file of diff.changedFiles) {
      const sources = file.sources?.length ? ` (${file.sources.join(", ")})` : "";
      lines.push(`- ${file.status || "?"} ${file.path}${sources}`);
    }
  }
  if (diff.summary) lines.push("", "## Diff Summary", diff.summary);
  lines.push("", "## Notes", "This Phase 5 review is deterministic and does not invoke an API-credit reviewer agent.");
  return lines.join("\n");
}

function summarizeReviewResults(runId, reviews) {
  const lines = [`# Multitask Review: ${runId}`, ""];
  if (!reviews.length) return `No reviewable tasks found for ${runId}.`;
  for (const review of reviews) {
    const failed = (review.checks || []).filter((check) => check.blocking !== false && !check.ok).length;
    lines.push(`- ${review.taskId}: ${review.decision}${failed ? ` (${failed} blocking check(s))` : ""}`);
    if (review.reviewPath) lines.push(`  review: ${review.reviewPath}`);
  }
  return lines.join("\n");
}

async function reviewTask(repoRoot, manifest, task, options = {}) {
  if (TERMINAL_STATUSES.has(task.status)) {
    return {
      runId: manifest.runId,
      taskId: task.id,
      skipped: true,
      decision: task.status,
      checks: [],
      reason: `Task is ${task.status}.`,
    };
  }
  if (!options.force && !REVIEWABLE_STATUSES.has(task.status)) {
    return {
      runId: manifest.runId,
      taskId: task.id,
      skipped: true,
      decision: task.status,
      checks: [],
      reason: `Task status ${task.status} is not reviewable yet.`,
    };
  }

  task.status = "reviewing";
  task.reviewStartedAt = new Date().toISOString();
  await saveTaskState(repoRoot, manifest.runId, task);
  await saveManifest(repoRoot, manifest);
  await appendTaskEvent(repoRoot, manifest.runId, task.id, "task_review_started", {});

  const checks = [];
  const diff = await getTaskDiff(repoRoot, manifest, task, options);
  const worktreeExists = task.worktree ? await pathExists(task.worktree) : false;
  const taskBranchExists = task.branch ? await branchExists(repoRoot, task.branch).catch(() => false) : false;
  const failures = validationFailures(task);
  const conflictMarkers = await scanConflictMarkers(task, diff);

  addCheck(checks, "worktree exists", worktreeExists, task.worktree);
  addCheck(checks, "branch exists", taskBranchExists, task.branch);
  addCheck(checks, "changed files detected", diff.changedFiles.length > 0, `${diff.changedFiles.length} changed file(s)`);
  addCheck(checks, "no unmerged git paths", (diff.unmergedFiles || []).length === 0, diff.unmergedFiles || []);
  addCheck(checks, "no conflict markers in changed text files", conflictMarkers.length === 0, conflictMarkers);
  addCheck(checks, "required validation did not fail", failures.length === 0, failures);
  addCheck(checks, "git diff commands completed", (diff.errors || []).length === 0, diff.errors || [], false);

  const decision = hasBlockingFailures(checks) ? "needs_changes" : "ready_to_merge";
  const reviewPath = task.paths?.review || taskReviewPath(repoRoot, manifest.runId, task.id);
  const markdown = formatReviewMarkdown({ manifest, task, diff, checks, decision });
  await ensureDir(path.dirname(reviewPath));
  await fsp.writeFile(reviewPath, markdown + "\n", "utf8");

  task.status = decision;
  task.review = {
    decision,
    reviewPath,
    reviewedAt: new Date().toISOString(),
    deterministic: true,
    checks,
    changedFileCount: diff.changedFiles.length,
  };
  task.reviewPath = reviewPath;
  task.diff = {
    changedFileCount: diff.changedFiles.length,
    unmergedFileCount: (diff.unmergedFiles || []).length,
    errors: diff.errors || [],
  };
  await saveTaskState(repoRoot, manifest.runId, task);
  await saveManifest(repoRoot, manifest);
  await appendTaskEvent(repoRoot, manifest.runId, task.id, "task_review_completed", {
    decision,
    reviewPath,
    changedFileCount: diff.changedFiles.length,
    blockingFailures: checks.filter((check) => check.blocking !== false && !check.ok).map((check) => check.name),
  });

  return {
    runId: manifest.runId,
    taskId: task.id,
    decision,
    reviewPath,
    checks,
    changedFiles: diff.changedFiles,
  };
}

async function reviewTasks(input = {}, options = {}) {
  if (!input.runId) throw new Error("runId is required for multitask review.");
  const repo = options.repo || await getRepoInfo(options.cwd || process.cwd());
  const manifest = options.manifest || await loadManifest(repo.root, slugify(input.runId, "run"));
  const tasks = input.taskId
    ? [selectTask(manifest, input.taskId)]
    : (manifest.tasks || []).filter((task) => REVIEWABLE_STATUSES.has(task.status));

  const reviews = [];
  for (const task of tasks) reviews.push(await reviewTask(repo.root, manifest, task, input));
  manifest.status = (manifest.tasks || []).some((task) => task.status === "needs_changes")
    ? "needs_attention"
    : (manifest.tasks || []).some((task) => task.status === "ready_to_merge")
      ? "ready_for_review"
      : manifest.status;
  await saveManifest(repo.root, manifest);

  const latestManifest = await loadManifest(repo.root, manifest.runId).catch(() => manifest);
  return {
    runId: manifest.runId,
    reviews,
    manifest: latestManifest,
    summary: summarizeReviewResults(manifest.runId, reviews),
  };
}

module.exports = {
  REVIEWABLE_STATUSES,
  formatReviewMarkdown,
  reviewTask,
  reviewTasks,
  summarizeReviewResults,
};
