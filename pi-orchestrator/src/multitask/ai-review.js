const { resolveAgent, agentConfigToWorkerLaunchMetadata } = require("./agents.js");
const { MESSAGE_TYPE, TASK_STATUS } = require("./contracts.js");
const { normalizeSupervisorMessage } = require("./messages.js");

const REVIEW_MODE = Object.freeze({
  DETERMINISTIC: "deterministic",
  AI: "ai",
  BOTH: "both",
});

const REVIEW_MODES = Object.freeze(Object.values(REVIEW_MODE));

const DEFAULT_REVIEW_CONFIG = Object.freeze({
  mode: REVIEW_MODE.DETERMINISTIC,
  reviewerAgent: "reviewer",
  maxRounds: 2,
  requireDeterministicPass: true,
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toText(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function normalizeMode(value, fallback = DEFAULT_REVIEW_CONFIG.mode) {
  if (value === true) return REVIEW_MODE.BOTH;
  if (value === false || value === null) return REVIEW_MODE.DETERMINISTIC;
  const text = String(value || fallback).trim().toLowerCase().replace(/[\s-]+/g, "_");
  const aliases = {
    off: REVIEW_MODE.DETERMINISTIC,
    none: REVIEW_MODE.DETERMINISTIC,
    no_ai: REVIEW_MODE.DETERMINISTIC,
    noai: REVIEW_MODE.DETERMINISTIC,
    deterministic_only: REVIEW_MODE.DETERMINISTIC,
    deterministic: REVIEW_MODE.DETERMINISTIC,
    ai: REVIEW_MODE.AI,
    ai_only: REVIEW_MODE.AI,
    both: REVIEW_MODE.BOTH,
    deterministic_and_ai: REVIEW_MODE.BOTH,
  };
  const normalized = aliases[text] || text;
  if (!REVIEW_MODES.includes(normalized)) {
    throw new Error(`review.mode must be one of: ${REVIEW_MODES.join(", ")}. Received: ${value}`);
  }
  return normalized;
}

function normalizePositiveInteger(value, fallback, label) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return Math.floor(number);
}

function selectConfigSources(input = {}, manifest = {}) {
  const explicit = input.review && isPlainObject(input.review) ? input.review : {};
  const manifestReviewConfig = manifest.reviewConfig && isPlainObject(manifest.reviewConfig)
    ? manifest.reviewConfig
    : manifest.review && isPlainObject(manifest.review) && manifest.review.mode
      ? manifest.review
      : {};
  const flat = {};
  for (const key of ["mode", "reviewerAgent", "maxRounds", "requireDeterministicPass"]) {
    if (input[key] !== undefined) flat[key] = input[key];
  }
  return [DEFAULT_REVIEW_CONFIG, manifestReviewConfig, explicit, flat];
}

function normalizeReviewConfig(input = {}, manifest = {}, options = {}) {
  const merged = Object.assign({}, DEFAULT_REVIEW_CONFIG, options.defaults || {}, ...selectConfigSources(input, manifest).slice(1));
  if (options.review && isPlainObject(options.review)) Object.assign(merged, options.review);
  const mode = normalizeMode(merged.mode, DEFAULT_REVIEW_CONFIG.mode);
  const reviewerAgent = String(merged.reviewerAgent || DEFAULT_REVIEW_CONFIG.reviewerAgent).trim() || DEFAULT_REVIEW_CONFIG.reviewerAgent;
  const maxRounds = normalizePositiveInteger(merged.maxRounds, DEFAULT_REVIEW_CONFIG.maxRounds, "review.maxRounds");
  const requireDeterministicPass = merged.requireDeterministicPass !== false;
  const aiEnabled = mode === REVIEW_MODE.AI || mode === REVIEW_MODE.BOTH;
  return {
    ...DEFAULT_REVIEW_CONFIG,
    mode,
    reviewerAgent,
    maxRounds,
    requireDeterministicPass,
    aiEnabled,
    deterministicRequired: requireDeterministicPass,
    creditConsuming: aiEnabled,
    noCredit: !aiEnabled,
  };
}

function aiReviewDisabledResult(config = normalizeReviewConfig()) {
  return {
    kind: "pi-multitask-ai-review",
    enabled: false,
    status: "disabled",
    decision: undefined,
    creditConsuming: false,
    noCredit: true,
    summary: "AI review is disabled; deterministic review remains no-credit.",
    reviewerAgent: config.reviewerAgent,
    findings: [],
    actionableFindings: [],
    hasActionableFindings: false,
  };
}

function aiReviewSkippedResult(config, reason, details) {
  return {
    kind: "pi-multitask-ai-review",
    enabled: true,
    status: "skipped",
    reason,
    details,
    decision: undefined,
    creditConsuming: false,
    noCredit: true,
    summary: `AI review skipped: ${reason}.`,
    reviewerAgent: config.reviewerAgent,
    findings: [],
    actionableFindings: [],
    hasActionableFindings: false,
  };
}

function extractJsonObjectFromText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (isPlainObject(parsed)) return parsed;
  } catch (_error) {}

  const fence = trimmed.match(/```(?:json|javascript|js)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      const parsed = JSON.parse(fence[1].trim());
      if (isPlainObject(parsed)) return parsed;
    } catch (_error) {}
  }
  return undefined;
}

function normalizeSeverity(value) {
  const text = String(value || "warning").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["blocker", "blocking", "critical", "high", "major"].includes(text)) return "major";
  if (["minor", "low", "medium", "warning"].includes(text)) return text === "medium" ? "warning" : text;
  if (["info", "informational", "note"].includes(text)) return "info";
  if (["nit", "nitpick", "style"].includes(text)) return "nit";
  return text || "warning";
}

function normalizeFinding(input, index = 0) {
  if (typeof input === "string") {
    return {
      id: `finding-${index + 1}`,
      severity: "warning",
      message: input.trim(),
      actionable: Boolean(input.trim()),
      raw: input,
    };
  }
  if (!isPlainObject(input)) return undefined;
  const severity = normalizeSeverity(input.severity || input.level || input.priority);
  const message = toText(input.message) || toText(input.summary) || toText(input.description) || toText(input.issue) || toText(input.action) || "";
  const actionable = input.actionable !== false
    && input.actionRequired !== false
    && input.action_required !== false
    && input.blocking !== false
    && !["info", "nit"].includes(severity)
    && Boolean(message || input.path || input.file);
  return {
    id: toText(input.id) || `finding-${index + 1}`,
    severity,
    path: toText(input.path) || toText(input.file),
    line: input.line === undefined ? undefined : Number(input.line),
    message,
    suggestion: toText(input.suggestion) || toText(input.fix) || toText(input.recommendation),
    category: toText(input.category) || toText(input.type),
    blocking: input.blocking === true || input.required === true || ["major"].includes(severity),
    actionable,
    raw: input,
  };
}

function normalizeFindings(source = {}) {
  const values = source.findings
    ?? source.actionableFindings
    ?? source.action_items
    ?? source.actionItems
    ?? source.actions
    ?? source.issues
    ?? [];
  const list = Array.isArray(values) ? values : [values];
  return list.map(normalizeFinding).filter(Boolean).filter((finding) => finding.message || finding.path);
}

function normalizeDecision(value, context = {}) {
  const text = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["needs_changes", "changes_requested", "request_changes", "changes_required", "fail", "failed"].includes(text)) return TASK_STATUS.NEEDS_CHANGES;
  if (["ready_to_merge", "approved", "approve", "pass", "passed", "clean", "ok"].includes(text)) return TASK_STATUS.READY_TO_MERGE;
  if (context.hasActionableFindings) return TASK_STATUS.NEEDS_CHANGES;
  return TASK_STATUS.READY_TO_MERGE;
}

function normalizeAiReviewOutput(output, context = {}) {
  const source = typeof output === "string" ? (extractJsonObjectFromText(output) || { summary: output }) : (isPlainObject(output) ? output : {});
  const findings = normalizeFindings(source);
  let actionableFindings = findings.filter((finding) => finding.actionable !== false && !["info", "nit"].includes(finding.severity));
  const requestedChanges = normalizeDecision(source.decision || source.status || source.result, { hasActionableFindings: false }) === TASK_STATUS.NEEDS_CHANGES;
  if (requestedChanges && !actionableFindings.length) {
    const summary = toText(source.summary) || toText(source.message) || (typeof output === "string" ? output.trim() : "AI reviewer requested changes.");
    if (summary) {
      actionableFindings = [{ id: "finding-1", severity: "warning", message: summary, actionable: true, raw: source }];
    }
  }
  const hasActionableFindings = actionableFindings.length > 0;
  const decision = normalizeDecision(source.decision || source.status || source.result, { hasActionableFindings });
  return {
    kind: "pi-multitask-ai-review",
    enabled: true,
    status: "completed",
    decision,
    creditConsuming: true,
    noCredit: false,
    reviewerAgent: context.reviewerAgent,
    reviewer: context.reviewer,
    reviewedAt: context.reviewedAt || new Date().toISOString(),
    summary: toText(source.summary) || toText(source.message) || (hasActionableFindings ? "AI reviewer requested changes." : "AI reviewer found no actionable changes."),
    findings,
    actionableFindings,
    hasActionableFindings,
    raw: output,
  };
}

function compactChangedFiles(diff = {}) {
  return (diff.changedFiles || []).map((file) => [file.status, file.path].filter(Boolean).join(" ")).join("\n");
}

function buildAiReviewPrompt({ manifest = {}, task = {}, diff = {}, deterministic = {}, config = DEFAULT_REVIEW_CONFIG }) {
  const lines = [
    "# Porchestrator AI Review",
    "",
    "AI review is opt-in and may consume Pi/API credits. Deterministic checks have already run and remain the mandatory no-credit baseline.",
    "",
    "## Assignment",
    `Run: ${manifest.runId || "(unknown)"}`,
    `Task: ${task.id || task.taskId || "(unknown)"}`,
    `Branch: ${task.branch || "(none)"}`,
    `Worktree: ${task.worktree || "(none)"}`,
    `Review round: ${deterministic.round || 1} of ${config.maxRounds || DEFAULT_REVIEW_CONFIG.maxRounds}`,
    "",
    "Review the changed files for correctness, regressions, missing validation, security risks, and integration readiness. Use read-only inspection unless explicitly asked otherwise.",
    "",
    "Return concise JSON with this shape:",
    "```json",
    JSON.stringify({
      decision: "ready_to_merge | needs_changes",
      summary: "short summary",
      findings: [{ severity: "major|warning|minor|info|nit", path: "optional/file", line: 1, message: "actionable issue", suggestion: "optional fix", actionable: true }],
    }, null, 2),
    "```",
    "",
    "## Deterministic Checks",
  ];
  for (const check of deterministic.checks || []) {
    lines.push(`- ${check.ok ? "pass" : check.blocking === false ? "warn" : "fail"}: ${check.name}${check.details === undefined ? "" : ` — ${typeof check.details === "string" ? check.details : JSON.stringify(check.details)}`}`);
  }
  lines.push("", "## Changed Files");
  const changedFiles = compactChangedFiles(diff);
  lines.push(changedFiles || "No changed files detected.");
  if (diff.summary) lines.push("", "## Diff Summary", diff.summary);
  return lines.join("\n");
}

async function runAiReview(input = {}, options = {}) {
  const config = input.config || normalizeReviewConfig(input.review || input, input.manifest || {}, options);
  if (!config.aiEnabled) return aiReviewDisabledResult(config);

  const resolver = options.resolveAgent || resolveAgent;
  const agentOptions = {
    repoRoot: input.repoRoot,
    ...(options.agentOptions || {}),
  };
  const agentResolution = await resolver(config.reviewerAgent, agentOptions);
  const launchMetadata = options.launchMetadata || agentConfigToWorkerLaunchMetadata(agentResolution, {
    manifest: input.manifest,
    task: input.task,
  });
  const prompt = input.prompt || buildAiReviewPrompt(input);

  const runner = options.runReviewer || options.reviewer || input.runReviewer;
  if (typeof runner !== "function") {
    const error = new Error("AI review mode requires a reviewer runner. Provide runReviewer/createReviewerSession from the caller; deterministic mode remains no-credit.");
    error.code = "PI_MULTITASK_AI_REVIEW_RUNNER_REQUIRED";
    error.creditConsuming = true;
    error.agentResolution = agentResolution;
    throw error;
  }

  const raw = await runner({
    prompt,
    config,
    manifest: input.manifest,
    task: input.task,
    diff: input.diff,
    deterministic: input.deterministic,
    agentResolution,
    launchMetadata,
    creditConsuming: true,
  });
  return {
    ...normalizeAiReviewOutput(raw, {
      reviewerAgent: config.reviewerAgent,
      reviewer: {
        name: agentResolution.agent?.name || agentResolution.name,
        source: agentResolution.agent?.source || agentResolution.source,
        file: agentResolution.agent?.file || agentResolution.file,
      },
    }),
    prompt,
    agent: {
      name: agentResolution.agent?.name || agentResolution.name,
      source: agentResolution.agent?.source || agentResolution.source,
      file: agentResolution.agent?.file || agentResolution.file,
    },
    launchMetadata,
  };
}

function formatFinding(finding) {
  const location = [finding.path, finding.line ? `:${finding.line}` : ""].filter(Boolean).join("");
  const prefix = [finding.severity, location].filter(Boolean).join(" ");
  const message = finding.message || finding.suggestion || "Review finding";
  return `${prefix ? `${prefix}: ` : ""}${message}${finding.suggestion ? ` — ${finding.suggestion}` : ""}`;
}

function formatAiReviewMarkdown(aiReview = {}) {
  if (!aiReview.enabled) return "AI review disabled. No AI credits consumed.";
  if (aiReview.status === "skipped") return `AI review skipped (${aiReview.reason}). No AI credits consumed.`;
  const lines = [
    `AI reviewer: ${aiReview.reviewerAgent || aiReview.agent?.name || "reviewer"}`,
    `Credit-consuming: ${aiReview.creditConsuming ? "yes" : "no"}`,
    `Decision: ${aiReview.decision || "(none)"}`,
    `Summary: ${aiReview.summary || "(none)"}`,
  ];
  if (aiReview.actionableFindings?.length) {
    lines.push("", "Actionable findings:");
    for (const finding of aiReview.actionableFindings) lines.push(`- ${formatFinding(finding)}`);
  } else if (aiReview.findings?.length) {
    lines.push("", "Non-blocking findings:");
    for (const finding of aiReview.findings) lines.push(`- ${formatFinding(finding)}`);
  }
  return lines.join("\n");
}

function createReviewFeedbackMessage(aiReview = {}, context = {}) {
  const taskId = context.taskId || context.task?.id || aiReview.taskId;
  const runId = context.runId || context.manifest?.runId || aiReview.runId;
  const actionItems = (aiReview.actionableFindings || []).map(formatFinding);
  return normalizeSupervisorMessage({
    runId,
    taskId,
    type: MESSAGE_TYPE.REVIEW_FEEDBACK,
    mode: context.mode || "followUp",
    correlationId: context.correlationId || `review-${taskId || "task"}-${context.round || 1}`,
    message: aiReview.summary || (actionItems.length ? "AI reviewer requested changes." : "Review completed."),
    payload: {
      decision: aiReview.decision,
      status: aiReview.decision,
      summary: aiReview.summary,
      actionItems,
      findings: aiReview.actionableFindings || [],
      changedFiles: context.diff?.changedFiles || context.changedFiles,
      creditConsuming: aiReview.creditConsuming === true,
      reviewerAgent: aiReview.reviewerAgent,
    },
  });
}

module.exports = {
  DEFAULT_REVIEW_CONFIG,
  REVIEW_MODE,
  REVIEW_MODES,
  aiReviewDisabledResult,
  aiReviewSkippedResult,
  buildAiReviewPrompt,
  createReviewFeedbackMessage,
  formatAiReviewMarkdown,
  normalizeAiReviewOutput,
  normalizeReviewConfig,
  runAiReview,
};
