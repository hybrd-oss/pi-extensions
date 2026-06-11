const { branchExists: gitBranchExists, getRepoInfo } = require("../git.js");
const { ensureDir, fsp, path, pathExists, slugify } = require("../utils.js");
const { appendTaskEvent } = require("./events.js");
const {
  loadManifest,
  saveManifest,
  saveTaskState,
  taskReviewPath,
} = require("./manifest.js");
const { getTaskDiff: defaultGetTaskDiff } = require("./diff.js");
const {
  MESSAGE_TYPE,
  TASK_STATUS,
  TERMINAL_TASK_STATUSES,
  inferRunStatusFromTasks,
} = require("./contracts.js");
const {
  aiReviewDisabledResult,
  aiReviewSkippedResult,
  createReviewFeedbackMessage,
  formatAiReviewMarkdown,
  normalizeReviewConfig,
  runAiReview,
} = require("./ai-review.js");
const { normalizeSupervisorMessage } = require("./messages.js");

const REVIEWABLE_STATUSES = new Set([
  TASK_STATUS.IDLE,
  TASK_STATUS.NEEDS_ATTENTION,
  TASK_STATUS.READY_FOR_REVIEW,
  TASK_STATUS.NEEDS_CHANGES,
  TASK_STATUS.READY_TO_MERGE,
]);

const TERMINAL_STATUSES = new Set(TERMINAL_TASK_STATUSES);

function selectTask(manifest, taskId) {
  const normalized = slugify(taskId, "task");
  const task = (manifest.tasks || []).find((candidate) => candidate.id === normalized || candidate.id === taskId);
  if (!task) throw new Error(`No multitask task ${taskId} in run ${manifest.runId}.`);
  return task;
}

function validationFailures(task) {
  return (Array.isArray(task.validation) ? task.validation : []).filter((result) => result?.status === "failed" && result.required !== false);
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

function formatReviewMarkdown({ manifest, task, diff, checks, decision, reviewConfig, aiReview, round }) {
  const aiStatus = aiReview || aiReviewDisabledResult(reviewConfig || normalizeReviewConfig());
  const lines = [
    `# Porchestrator Review: ${manifest.runId}/${task.id}`,
    "",
    `Decision: **${decision}**`,
    `Reviewed at: ${new Date().toISOString()}`,
    `Branch: ${task.branch || "(none)"}`,
    `Worktree: ${task.worktree || "(none)"}`,
    `Changed files: ${(diff.changedFiles || []).length}`,
  ];
  if (reviewConfig) {
    lines.push(
      `Review mode: ${reviewConfig.mode}`,
      `Review round: ${round || 1} of ${reviewConfig.maxRounds}`,
      `Require deterministic pass: ${reviewConfig.requireDeterministicPass ? "yes" : "no"}`,
    );
  }
  lines.push("", "## Deterministic Checks");
  for (const check of checks) {
    const marker = check.ok ? "pass" : check.blocking === false ? "warn" : "fail";
    lines.push(`- [${marker}] ${check.name}${check.details === undefined ? "" : ` — ${typeof check.details === "string" ? check.details : JSON.stringify(check.details)}`}`);
  }
  lines.push("", "## Changed Files");
  if (!diff.changedFiles?.length) lines.push("No changed files detected.");
  else {
    for (const file of diff.changedFiles) {
      const sources = file.sources?.length ? ` (${file.sources.join(", ")})` : "";
      lines.push(`- ${file.status || "?"} ${file.path}${sources}`);
    }
  }
  if (diff.summary) lines.push("", "## Diff Summary", diff.summary);
  lines.push("", "## AI Review", formatAiReviewMarkdown(aiStatus));
  lines.push(
    "",
    "## Credit Notice",
    aiStatus.creditConsuming
      ? "AI review was enabled for this task and is credit-consuming. Deterministic checks above remain no-credit."
      : "This review used the deterministic no-credit baseline only and does not invoke an API-credit reviewer agent.",
  );
  return lines.join("\n");
}

function summarizeReviewResults(runId, reviews) {
  const lines = [`# Porchestrator Review: ${runId}`, ""];
  if (!reviews.length) return `No reviewable tasks found for ${runId}.`;
  for (const review of reviews) {
    const failed = (review.checks || []).filter((check) => check.blocking !== false && !check.ok).length;
    const credit = review.creditConsuming ? " · AI review credit-consuming" : " · no-credit deterministic";
    lines.push(`- ${review.taskId}: ${review.decision}${failed ? ` (${failed} blocking check(s))` : ""}${credit}`);
    if (review.aiReview?.hasActionableFindings) lines.push(`  AI findings: ${review.aiReview.actionableFindings.length} actionable`);
    if (review.reviewPath) lines.push(`  review: ${review.reviewPath}`);
  }
  return lines.join("\n");
}

function nextReviewRound(task) {
  const round = Number(task.review?.round || 0) + 1;
  return Number.isFinite(round) && round > 0 ? Math.floor(round) : 1;
}

function deterministicDecision(checks, reviewConfig) {
  if (reviewConfig.requireDeterministicPass && hasBlockingFailures(checks)) return TASK_STATUS.NEEDS_CHANGES;
  return TASK_STATUS.READY_TO_MERGE;
}

async function runDeterministicReview(repoRoot, manifest, task, options = {}) {
  const checks = [];
  const getTaskDiff = options.getTaskDiff || defaultGetTaskDiff;
  const branchExists = options.branchExists || gitBranchExists;
  const diff = await getTaskDiff(repoRoot, manifest, task, options);
  const worktreeExists = task.worktree ? await pathExists(task.worktree) : false;
  const taskBranchExists = task.branch ? await branchExists(repoRoot, task.branch).catch(() => false) : false;
  const failures = validationFailures(task);
  const conflictMarkers = await scanConflictMarkers(task, diff);

  addCheck(checks, "worktree exists", worktreeExists, task.worktree);
  addCheck(checks, "branch exists", taskBranchExists, task.branch);
  addCheck(checks, "changed files detected", (diff.changedFiles || []).length > 0, `${(diff.changedFiles || []).length} changed file(s)`);
  addCheck(checks, "no unmerged git paths", (diff.unmergedFiles || []).length === 0, diff.unmergedFiles || []);
  addCheck(checks, "no conflict markers in changed text files", conflictMarkers.length === 0, conflictMarkers);
  addCheck(checks, "required validation did not fail", failures.length === 0, failures);
  addCheck(checks, "git diff commands completed", (diff.errors || []).length === 0, diff.errors || [], false);

  return {
    diff,
    checks,
    blockingFailures: checks.filter((check) => check.blocking !== false && !check.ok),
    passed: !hasBlockingFailures(checks),
  };
}

function compactAiReviewForTask(aiReview) {
  if (!aiReview) return undefined;
  return {
    enabled: aiReview.enabled === true,
    status: aiReview.status,
    reason: aiReview.reason,
    decision: aiReview.decision,
    creditConsuming: aiReview.creditConsuming === true,
    noCredit: aiReview.noCredit === true,
    reviewerAgent: aiReview.reviewerAgent,
    reviewer: aiReview.reviewer || aiReview.agent,
    reviewedAt: aiReview.reviewedAt,
    summary: aiReview.summary,
    findings: aiReview.findings || [],
    actionableFindings: aiReview.actionableFindings || [],
    hasActionableFindings: aiReview.hasActionableFindings === true,
  };
}

function finalDecisionForReview({ deterministic, aiReview, reviewConfig }) {
  if (reviewConfig.requireDeterministicPass && !deterministic.passed) return TASK_STATUS.NEEDS_CHANGES;
  if (aiReview?.enabled && aiReview.status === "completed" && aiReview.hasActionableFindings) return TASK_STATUS.NEEDS_CHANGES;
  if (aiReview?.enabled && aiReview.status === "skipped" && reviewConfig.aiEnabled) {
    if (aiReview.reason === "max_rounds_reached") return TASK_STATUS.NEEDS_CHANGES;
  }
  return TASK_STATUS.READY_TO_MERGE;
}

function formatCheckDetails(details) {
  if (details === undefined) return "";
  return typeof details === "string" ? details : JSON.stringify(details);
}

function createDeterministicFeedbackMessage(deterministic, context = {}) {
  const actionItems = (deterministic.blockingFailures || []).map((check) => {
    const details = formatCheckDetails(check.details);
    return `${check.name}${details ? `: ${details}` : ""}`;
  });
  return normalizeSupervisorMessage({
    runId: context.manifest?.runId,
    taskId: context.task?.id,
    type: MESSAGE_TYPE.REVIEW_FEEDBACK,
    mode: context.mode || "followUp",
    correlationId: context.correlationId || `review-${context.task?.id || "task"}-${context.round || 1}`,
    message: actionItems.length
      ? "Deterministic review found blocking issues that must be fixed before merge."
      : "Deterministic review completed.",
    payload: {
      decision: TASK_STATUS.NEEDS_CHANGES,
      status: TASK_STATUS.NEEDS_CHANGES,
      summary: "Deterministic review found blocking issues that must be fixed before merge.",
      actionItems,
      checks: deterministic.checks || [],
      deterministic: true,
      creditConsuming: false,
    },
  });
}

async function maybeSendReviewFeedback(feedback, context, options = {}) {
  if (!feedback || typeof options.sendReviewFeedback !== "function") return undefined;
  const result = await options.sendReviewFeedback({ ...context, feedback });
  await appendTaskEvent(context.repoRoot, context.manifest.runId, context.task.id, "task_review_feedback_sent", {
    decision: context.decision,
    correlationId: feedback.correlationId,
  });
  return result;
}

async function reviewTask(repoRoot, manifest, task, options = {}) {
  const reviewConfig = normalizeReviewConfig(options, manifest);
  if (TERMINAL_STATUSES.has(task.status)) {
    return {
      runId: manifest.runId,
      taskId: task.id,
      skipped: true,
      decision: task.status,
      checks: [],
      reason: `Task is ${task.status}.`,
      reviewConfig,
      creditConsuming: false,
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
      reviewConfig,
      creditConsuming: false,
    };
  }

  const round = nextReviewRound(task);
  task.reviewStartedAt = new Date().toISOString();
  task.review = {
    ...(task.review || {}),
    inProgress: true,
    round,
    maxRounds: reviewConfig.maxRounds,
    config: reviewConfig,
  };
  await saveTaskState(repoRoot, manifest.runId, task);
  await saveManifest(repoRoot, manifest);
  await appendTaskEvent(repoRoot, manifest.runId, task.id, "task_review_started", {
    mode: reviewConfig.mode,
    round,
    maxRounds: reviewConfig.maxRounds,
    aiCreditConsuming: reviewConfig.aiEnabled,
  });

  const deterministic = await runDeterministicReview(repoRoot, manifest, task, options);
  let aiReview = aiReviewDisabledResult(reviewConfig);
  let aiError;
  if (reviewConfig.aiEnabled) {
    if (round > reviewConfig.maxRounds) {
      aiReview = aiReviewSkippedResult(reviewConfig, "max_rounds_reached", { round, maxRounds: reviewConfig.maxRounds });
    } else if (reviewConfig.requireDeterministicPass && !deterministic.passed) {
      aiReview = aiReviewSkippedResult(reviewConfig, "deterministic_failed", {
        blockingFailures: deterministic.blockingFailures.map((check) => check.name),
      });
    } else {
      try {
        aiReview = await runAiReview({
          repoRoot,
          manifest,
          task,
          diff: deterministic.diff,
          deterministic: { checks: deterministic.checks, passed: deterministic.passed, round },
          config: reviewConfig,
        }, options);
      } catch (error) {
        aiError = error;
        aiReview = {
          kind: "pi-multitask-ai-review",
          enabled: true,
          status: "failed",
          decision: undefined,
          creditConsuming: true,
          noCredit: false,
          reviewerAgent: reviewConfig.reviewerAgent,
          summary: error.message,
          error: { code: error.code, message: error.message },
          findings: [],
          actionableFindings: [],
          hasActionableFindings: false,
        };
      }
    }
  }

  const decision = aiError
    ? TASK_STATUS.NEEDS_ATTENTION
    : finalDecisionForReview({ deterministic, aiReview, reviewConfig }) || deterministicDecision(deterministic.checks, reviewConfig);
  let feedback;
  if (decision === TASK_STATUS.NEEDS_CHANGES && aiReview?.hasActionableFindings) {
    feedback = createReviewFeedbackMessage(aiReview, {
      manifest,
      task,
      diff: deterministic.diff,
      round,
      correlationId: `review-${task.id}-${round}`,
    });
  } else if (decision === TASK_STATUS.NEEDS_CHANGES && deterministic.blockingFailures.length) {
    feedback = createDeterministicFeedbackMessage(deterministic, {
      manifest,
      task,
      round,
      correlationId: `review-${task.id}-${round}`,
    });
  }
  const feedbackResult = await maybeSendReviewFeedback(feedback, {
    repoRoot,
    manifest,
    task,
    reviewConfig,
    aiReview,
    deterministic,
    decision,
  }, options);

  const reviewPath = task.paths?.review || taskReviewPath(repoRoot, manifest.runId, task.id);
  const markdown = formatReviewMarkdown({
    manifest,
    task,
    diff: deterministic.diff,
    checks: deterministic.checks,
    decision,
    reviewConfig,
    aiReview,
    round,
  });
  await ensureDir(path.dirname(reviewPath));
  await fsp.writeFile(reviewPath, markdown + "\n", "utf8");

  const previousHistory = Array.isArray(task.review?.history) ? task.review.history : [];
  task.status = decision;
  task.review = {
    decision,
    reviewPath,
    reviewedAt: new Date().toISOString(),
    deterministic: true,
    checks: deterministic.checks,
    changedFileCount: (deterministic.diff.changedFiles || []).length,
    config: reviewConfig,
    round,
    maxRounds: reviewConfig.maxRounds,
    creditConsuming: aiReview.creditConsuming === true,
    noCredit: aiReview.creditConsuming !== true,
    ai: compactAiReviewForTask(aiReview),
    feedback: feedback ? {
      prompt: feedback.prompt,
      dto: feedback.dto,
      sent: Boolean(feedbackResult),
      sendResult: feedbackResult,
    } : undefined,
    error: aiError ? { code: aiError.code, message: aiError.message } : undefined,
    history: previousHistory.slice(-9),
  };
  task.reviewPath = reviewPath;
  task.diff = {
    changedFileCount: (deterministic.diff.changedFiles || []).length,
    unmergedFileCount: (deterministic.diff.unmergedFiles || []).length,
    errors: deterministic.diff.errors || [],
  };
  await saveTaskState(repoRoot, manifest.runId, task);
  await saveManifest(repoRoot, manifest);
  await appendTaskEvent(repoRoot, manifest.runId, task.id, "task_review_completed", {
    decision,
    reviewPath,
    changedFileCount: (deterministic.diff.changedFiles || []).length,
    blockingFailures: deterministic.blockingFailures.map((check) => check.name),
    reviewMode: reviewConfig.mode,
    aiReviewStatus: aiReview.status,
    aiCreditConsuming: aiReview.creditConsuming === true,
    actionableAiFindings: aiReview.actionableFindings?.length || 0,
  });

  return {
    runId: manifest.runId,
    taskId: task.id,
    decision,
    reviewPath,
    checks: deterministic.checks,
    changedFiles: deterministic.diff.changedFiles || [],
    deterministic: {
      passed: deterministic.passed,
      blockingFailures: deterministic.blockingFailures,
      noCredit: true,
    },
    reviewConfig,
    aiReview: compactAiReviewForTask(aiReview),
    creditConsuming: aiReview.creditConsuming === true,
    noCredit: aiReview.creditConsuming !== true,
    feedback,
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
  for (const task of tasks) reviews.push(await reviewTask(repo.root, manifest, task, { ...options, ...input }));
  manifest.status = inferRunStatusFromTasks(manifest.tasks || []);
  await saveManifest(repo.root, manifest);

  const latestManifest = await loadManifest(repo.root, manifest.runId).catch(() => manifest);
  const creditConsuming = reviews.some((review) => review.creditConsuming === true);
  return {
    runId: manifest.runId,
    reviews,
    manifest: latestManifest,
    creditConsuming,
    noCredit: !creditConsuming,
    summary: summarizeReviewResults(manifest.runId, reviews),
  };
}

module.exports = {
  REVIEWABLE_STATUSES,
  formatReviewMarkdown,
  reviewTask,
  reviewTasks,
  runDeterministicReview,
  summarizeReviewResults,
};
