const {
  CONTRACT_SCHEMA_VERSION,
  MESSAGE_DIRECTION,
  MESSAGE_MODE,
  MESSAGE_TYPE,
  TASK_STATUS,
  assertMessageMode,
  assertMessageType,
  assertTaskStatus,
  createMessageDto,
  isAttentionTaskStatus,
} = require("./contracts.js");

const REPORT_REASON = Object.freeze({
  DONE: "done",
  NEED_DECISION: "need_decision",
  BLOCKED: "blocked",
  ERROR: "error",
});

const REPORT_REASONS = Object.freeze(Object.values(REPORT_REASON));
const REPORT_REASON_SET = new Set(REPORT_REASONS);

const WORKER_REPORT_KIND = "pi-multitask-worker-report";
const MESSAGE_ENVELOPE_KIND = "pi-multitask-message-envelope";
const TASK_TRANSITION_KIND = "pi-multitask-task-transition";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compactLines(lines) {
  return lines.filter((line, index) => {
    if (line !== "") return true;
    return index > 0 && lines[index - 1] !== "" && lines[index + 1] !== "" && lines[index + 1] !== undefined;
  }).join("\n").trimEnd();
}

function toText(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function normalizeMode(mode, fallback = MESSAGE_MODE.FOLLOW_UP) {
  const value = toText(mode) || fallback;
  const aliases = {
    follow_up: MESSAGE_MODE.FOLLOW_UP,
    "follow-up": MESSAGE_MODE.FOLLOW_UP,
    followup: MESSAGE_MODE.FOLLOW_UP,
    followUp: MESSAGE_MODE.FOLLOW_UP,
    prompt: MESSAGE_MODE.PROMPT,
    steer: MESSAGE_MODE.STEER,
  };
  const normalized = aliases[value] || value;
  return assertMessageMode(normalized);
}

function normalizeMessageType(type, fallback = MESSAGE_TYPE.INFORM) {
  const value = toText(type) || fallback;
  return assertMessageType(value);
}

function normalizeCorrelationId(input, context = {}) {
  return toText(input?.correlationId) || toText(input?.correlation_id) || toText(context.correlationId) || toText(context.correlation_id);
}

function isExplicitTypedInput(input, context = {}) {
  if (!isPlainObject(input)) return false;
  return Boolean(
    input.type !== undefined
      || context.type !== undefined
      || input.correlationId !== undefined
      || input.correlation_id !== undefined
      || context.correlationId !== undefined
      || context.correlation_id !== undefined
      || input.payload !== undefined
      || input.direction !== undefined
      || context.direction !== undefined,
  );
}

function supervisorMessageText(input = {}, context = {}) {
  if (typeof input === "string") return input;
  if (!isPlainObject(input)) throw new Error("multitask message must be a string or an object envelope.");
  const text = toText(input.message)
    ?? toText(input.text)
    ?? toText(input.summary)
    ?? toText(context.message)
    ?? toText(context.text)
    ?? "";
  if (typeof text !== "string") throw new Error("multitask message text must be a string.");
  return text;
}

function normalizeSupervisorMessage(input, context = {}) {
  const objectInput = isPlainObject(input) ? input : {};
  const text = supervisorMessageText(input, context);
  const runId = objectInput.runId || context.runId;
  const taskId = objectInput.taskId || context.taskId;
  const type = normalizeMessageType(objectInput.type ?? context.type, MESSAGE_TYPE.INFORM);
  const mode = normalizeMode(objectInput.mode ?? context.mode, MESSAGE_MODE.FOLLOW_UP);
  const direction = objectInput.direction || context.direction || MESSAGE_DIRECTION.SUPERVISOR_TO_WORKER;
  const isTyped = isExplicitTypedInput(input, context);
  const payload = objectInput.payload !== undefined ? objectInput.payload : context.payload;
  const dto = createMessageDto({
    id: objectInput.id || context.id,
    runId,
    taskId,
    type,
    direction,
    mode,
    correlationId: normalizeCorrelationId(objectInput, context),
    from: objectInput.from || context.from,
    to: objectInput.to || context.to,
    text,
    createdAt: objectInput.createdAt || context.createdAt,
    payload,
  });
  const prompt = isTyped ? formatMessageForWorker(dto, { typed: true }) : dto.text;
  return {
    kind: MESSAGE_ENVELOPE_KIND,
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    isTyped,
    runId: dto.runId,
    taskId: dto.taskId,
    type: dto.type,
    mode: dto.mode,
    correlationId: dto.correlationId,
    text: dto.text,
    prompt,
    transport: {
      message: prompt,
      mode: dto.mode,
    },
    dto,
  };
}

function normalizeMessageEnvelope(input, context = {}) {
  return normalizeSupervisorMessage(input, context);
}

function listSection(title, values) {
  const items = normalizeList(values);
  if (!items.length) return [];
  return [title, ...items.map((item) => `- ${formatListItem(item)}`)];
}

function normalizeList(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null);
  return [value];
}

function formatListItem(item) {
  if (typeof item === "string") return item;
  if (isPlainObject(item)) {
    const path = item.path || item.file || item.name;
    const status = item.status || item.ok;
    const summary = item.summary || item.message || item.reason || item.description;
    return [path, status, summary].filter((part) => part !== undefined && part !== null && part !== "").join(" — ") || JSON.stringify(item);
  }
  return String(item);
}

function formatValidation(value) {
  const validation = normalizeValidation(value);
  if (!validation) return [];
  const lines = ["Validation:"];
  if (validation.status) lines.push(`- Status: ${validation.status}`);
  if (validation.summary) lines.push(`- Summary: ${validation.summary}`);
  if (validation.command) lines.push(`- Command: ${validation.command}`);
  for (const check of validation.checks || []) lines.push(`- ${formatListItem(check)}`);
  return lines;
}

function formatDecisionPrompt(message) {
  const payload = isPlainObject(message.payload) ? message.payload : {};
  const lines = ["Porchestrator decision from supervisor"];
  if (message.correlationId) lines.push(`Correlation ID: ${message.correlationId}`);
  if (payload.question) lines.push("", "Question/request being answered:", String(payload.question));
  lines.push("", "Decision:", message.text || "(no decision text supplied)");
  if (payload.rationale) lines.push("", "Rationale:", String(payload.rationale));
  lines.push(
    "",
    "Continue from the point where you requested this decision. If this unblocks the task, resume work and send a report_done message when ready for review. If it does not unblock you, send report_blocked with the remaining blocker.",
  );
  return compactLines(lines);
}

function formatReviewFeedbackPrompt(message) {
  const payload = isPlainObject(message.payload) ? message.payload : {};
  const decision = payload.decision || payload.status;
  const lines = ["Porchestrator review feedback from supervisor"];
  if (message.correlationId) lines.push(`Correlation ID: ${message.correlationId}`);
  if (decision) lines.push(`Review decision: ${decision}`);
  lines.push("", "Summary:", message.text || payload.summary || "Review feedback is attached.");
  lines.push("", ...listSection("Action items:", payload.actionItems || payload.actions || payload.findings));
  const changedFiles = normalizeChangedFiles(payload.changedFiles ?? payload["changed-files"] ?? payload.changed_files);
  if (changedFiles.length) lines.push("", ...listSection("Changed files referenced:", changedFiles));
  const validationLines = formatValidation(payload.validation);
  if (validationLines.length) lines.push("", ...validationLines);
  lines.push("");
  if (decision === TASK_STATUS.READY_TO_MERGE || decision === "approved" || decision === "pass") {
    lines.push("Review passed. No follow-up changes are requested unless you notice a critical issue.");
  } else {
    lines.push("Please address the feedback, run relevant validation, and send report_done when the task is ready for review again. If you are blocked, send report_blocked with the blocker.");
  }
  return compactLines(lines);
}

function formatAssignmentPrompt(message) {
  const payload = isPlainObject(message.payload) ? message.payload : {};
  const lines = ["Porchestrator assignment from supervisor"];
  if (message.correlationId) lines.push(`Correlation ID: ${message.correlationId}`);
  lines.push("", "Assignment:", message.text || "(no assignment text supplied)");
  lines.push("", ...listSection("Acceptance criteria:", payload.acceptance || payload.acceptanceCriteria));
  lines.push("", ...listSection("Validation:", payload.validationScripts || payload.validation));
  return compactLines(lines);
}

function formatQuestionPrompt(message) {
  const lines = ["Question from supervisor"];
  if (message.correlationId) lines.push(`Correlation ID: ${message.correlationId}`);
  lines.push("", message.text || "(no question text supplied)");
  lines.push("", "Answer clearly, then continue working if possible. If the question blocks you, send report_blocked with reason need_decision.");
  return compactLines(lines);
}

function formatInformPrompt(message) {
  const lines = ["Update from supervisor"];
  if (message.correlationId) lines.push(`Correlation ID: ${message.correlationId}`);
  lines.push("", message.text || "(no update text supplied)");
  return compactLines(lines);
}

function formatMessageForWorker(message, options = {}) {
  const dto = message?.kind === "pi-multitask-message" ? message : createMessageDto(message || {}, options.context || {});
  if (!options.typed && dto.type === MESSAGE_TYPE.INFORM && !dto.correlationId && !dto.payload) return dto.text;
  switch (dto.type) {
    case MESSAGE_TYPE.DECISION:
      return formatDecisionPrompt(dto);
    case MESSAGE_TYPE.REVIEW_FEEDBACK:
      return formatReviewFeedbackPrompt(dto);
    case MESSAGE_TYPE.ASSIGNMENT:
      return formatAssignmentPrompt(dto);
    case MESSAGE_TYPE.QUESTION:
      return formatQuestionPrompt(dto);
    case MESSAGE_TYPE.INFORM:
      return formatInformPrompt(dto);
    default:
      return dto.text;
  }
}

function normalizeReportReason(reason, context = {}) {
  const raw = toText(reason);
  const text = raw ? raw.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  const summary = toText(context.summary)?.toLowerCase() || "";
  const status = toText(context.status)?.toLowerCase() || "";
  const type = context.type;
  if (text) {
    if (["done", "complete", "completed", "ready", "ready_for_review", "report_done"].includes(text)) return REPORT_REASON.DONE;
    if (["need_decision", "needs_decision", "decision", "decision_needed", "question", "needs_attention"].includes(text)) return REPORT_REASON.NEED_DECISION;
    if (["blocked", "blocker", "stuck", "waiting"].includes(text)) return REPORT_REASON.BLOCKED;
    if (["error", "failed", "failure", "exception"].includes(text)) return REPORT_REASON.ERROR;
    if (REPORT_REASON_SET.has(text)) return text;
  }
  if (type === MESSAGE_TYPE.REPORT_DONE || status === TASK_STATUS.READY_FOR_REVIEW) return REPORT_REASON.DONE;
  if (type === MESSAGE_TYPE.QUESTION) return REPORT_REASON.NEED_DECISION;
  if (type === MESSAGE_TYPE.REPORT_BLOCKED) {
    if (/decision|question|choose|approval|confirm/.test(summary)) return REPORT_REASON.NEED_DECISION;
    return REPORT_REASON.BLOCKED;
  }
  if (/need[s]? (a )?(decision|answer|approval)|decision needed|which option|should i|\?$/.test(summary)) return REPORT_REASON.NEED_DECISION;
  if (/blocked|blocker|stuck|waiting on|cannot continue/.test(summary)) return REPORT_REASON.BLOCKED;
  if (/error|failed|exception|crash/.test(summary)) return REPORT_REASON.ERROR;
  if (/ready for review|done|completed|complete/.test(summary)) return REPORT_REASON.DONE;
  return undefined;
}

function normalizeReportStatus(status, context = {}) {
  const reason = context.reason;
  const type = context.type;
  const raw = toText(status);
  const text = raw ? raw.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  let normalized;
  if ([TASK_STATUS.READY_FOR_REVIEW, "ready", "done", "complete", "completed", "report_done"].includes(text)) normalized = TASK_STATUS.READY_FOR_REVIEW;
  else if ([TASK_STATUS.NEEDS_ATTENTION, "attention", "need_decision", "needs_decision", "decision_needed", "question"].includes(text)) normalized = TASK_STATUS.NEEDS_ATTENTION;
  else if ([TASK_STATUS.BLOCKED, "report_blocked", "blocked", "stuck"].includes(text)) normalized = TASK_STATUS.BLOCKED;

  if (!normalized) {
    if (reason === REPORT_REASON.DONE || type === MESSAGE_TYPE.REPORT_DONE) normalized = TASK_STATUS.READY_FOR_REVIEW;
    else if (reason === REPORT_REASON.NEED_DECISION || reason === REPORT_REASON.ERROR || type === MESSAGE_TYPE.QUESTION) normalized = TASK_STATUS.NEEDS_ATTENTION;
    else if (reason === REPORT_REASON.BLOCKED || type === MESSAGE_TYPE.REPORT_BLOCKED) normalized = TASK_STATUS.BLOCKED;
  }

  if (reason === REPORT_REASON.NEED_DECISION) normalized = TASK_STATUS.NEEDS_ATTENTION;
  if (reason === REPORT_REASON.ERROR && normalized !== TASK_STATUS.BLOCKED) normalized = TASK_STATUS.NEEDS_ATTENTION;
  if (!normalized) return undefined;
  return assertTaskStatus(normalized);
}

function normalizeReportType(type, context = {}) {
  const raw = toText(type);
  if (!raw) return context.reason === REPORT_REASON.DONE ? MESSAGE_TYPE.REPORT_DONE : context.reason ? MESSAGE_TYPE.REPORT_BLOCKED : undefined;
  const value = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (value === "need_decision" || value === "needs_decision") return MESSAGE_TYPE.QUESTION;
  if (value === "done") return MESSAGE_TYPE.REPORT_DONE;
  if (value === "blocked") return MESSAGE_TYPE.REPORT_BLOCKED;
  if (value === "report_done" || value === "report_blocked" || value === "question") return assertMessageType(value);
  return assertMessageType(value);
}

function normalizeChangedFiles(value) {
  if (value === undefined || value === null || value === "") return [];
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,\n]/)
      : [value];
  return values.map((entry) => {
    if (typeof entry === "string") return entry.trim();
    if (isPlainObject(entry)) {
      const path = toText(entry.path) || toText(entry.file) || toText(entry.name);
      if (!path) return undefined;
      return {
        path,
        status: toText(entry.status),
        oldPath: toText(entry.oldPath) || toText(entry.old_path),
        source: toText(entry.source),
      };
    }
    return undefined;
  }).filter((entry) => {
    if (!entry) return false;
    if (typeof entry === "string") return entry.length > 0;
    return true;
  });
}

function normalizeValidation(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return { summary: value };
  if (Array.isArray(value)) return { checks: value };
  if (isPlainObject(value)) {
    return {
      status: toText(value.status) || (typeof value.ok === "boolean" ? (value.ok ? "passed" : "failed") : undefined),
      summary: toText(value.summary) || toText(value.message) || toText(value.output),
      command: toText(value.command),
      checks: Array.isArray(value.checks) ? value.checks : undefined,
      raw: value.raw,
    };
  }
  return { summary: String(value) };
}

function extractJsonObjectFromText(text) {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (isPlainObject(parsed)) return parsed;
  } catch (_error) {}

  const marker = trimmed.match(/PI_MULTITASK_REPORT\s*:\s*({[\s\S]*})\s*$/i);
  if (marker) {
    try {
      const parsed = JSON.parse(marker[1]);
      if (isPlainObject(parsed)) return parsed;
    } catch (_error) {}
  }

  const fence = trimmed.match(/```(?:json|javascript|js)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      const parsed = JSON.parse(fence[1].trim());
      if (isPlainObject(parsed)) return parsed;
    } catch (_error) {}
  }
  return undefined;
}

function keyName(key) {
  return String(key || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function parseKeyValueReport(text) {
  const fields = {};
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^\s*(?:[-*]\s*)?([A-Za-z][A-Za-z0-9 _-]{1,40})\s*:\s*(.*)$/);
    if (!match) continue;
    const key = keyName(match[1]);
    let value = match[2].trim();
    if ((key === "changed_files" || key === "changed_file" || key === "files") && !value) {
      const collected = [];
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const bullet = lines[cursor].match(/^\s*[-*]\s+(.+)$/);
        if (!bullet) break;
        collected.push(bullet[1].trim());
      }
      value = collected.join("\n");
    }
    fields[key] = value;
  }
  if (!Object.keys(fields).length) return undefined;
  return {
    type: fields.type,
    status: fields.status,
    reason: fields.reason,
    summary: fields.summary || fields.message || fields.question,
    question: fields.question,
    changedFiles: fields.changed_files || fields.changed_file || fields.files,
    validation: fields.validation,
    correlationId: fields.correlation_id,
  };
}

function parsePrefixedReport(text) {
  const trimmed = text.trim();
  const firstLine = trimmed.split(/\r?\n/, 1)[0] || "";
  const match = firstLine.match(/^\s*(need[_ -]?decision|needs[_ -]?decision|decision[_ -]?needed|report[_ -]?blocked|blocked|report[_ -]?done|done|ready[_ -]?for[_ -]?review|error|failed)\s*:\s*(.*)$/i);
  if (!match) return undefined;
  const prefix = match[1].toLowerCase().replace(/[\s-]+/g, "_");
  const firstSummary = match[2].trim();
  const rest = trimmed.slice(firstLine.length).trim();
  const summary = [firstSummary, rest].filter(Boolean).join("\n").trim();
  if (["need_decision", "needs_decision", "decision_needed"].includes(prefix)) {
    return { type: MESSAGE_TYPE.QUESTION, status: TASK_STATUS.NEEDS_ATTENTION, reason: REPORT_REASON.NEED_DECISION, summary, question: summary };
  }
  if (prefix === "report_blocked" || prefix === "blocked") {
    return { type: MESSAGE_TYPE.REPORT_BLOCKED, reason: normalizeReportReason(undefined, { type: MESSAGE_TYPE.REPORT_BLOCKED, summary }), summary };
  }
  if (prefix === "report_done" || prefix === "done" || prefix === "ready_for_review") {
    return { type: MESSAGE_TYPE.REPORT_DONE, status: TASK_STATUS.READY_FOR_REVIEW, reason: REPORT_REASON.DONE, summary };
  }
  return { status: TASK_STATUS.NEEDS_ATTENTION, reason: REPORT_REASON.ERROR, summary };
}

function parseProseReport(text) {
  const summary = text.trim();
  if (!summary) return undefined;
  const reason = normalizeReportReason(undefined, { summary });
  if (!reason) return undefined;
  return { reason, summary };
}

function coerceReportSource(input) {
  if (typeof input === "string") {
    const parsedJson = extractJsonObjectFromText(input);
    if (parsedJson) return { ...parsedJson, raw: input };
    return { ...(parsePrefixedReport(input) || parseKeyValueReport(input) || parseProseReport(input) || {}), raw: input };
  }
  if (isPlainObject(input)) {
    if (input.kind === "pi-multitask-message") {
      return {
        ...(isPlainObject(input.payload) ? input.payload : {}),
        type: input.type,
        status: input.payload?.status,
        reason: input.payload?.reason,
        summary: input.payload?.summary || input.text,
        question: input.payload?.question,
        changedFiles: input.payload?.changedFiles,
        validation: input.payload?.validation,
        correlationId: input.correlationId,
        raw: input,
      };
    }
    return { ...input, raw: input };
  }
  throw new Error("worker report must be a string or object.");
}

function reportSummary(source) {
  return toText(source.summary)
    ?? toText(source.message)
    ?? toText(source.text)
    ?? toText(source.question)
    ?? toText(source.error)
    ?? "";
}

function normalizeWorkerReport(input, context = {}) {
  const source = coerceReportSource(input);
  const summary = reportSummary(source);
  let type = normalizeReportType(source.type, {});
  let reason = normalizeReportReason(source.reason, { type, status: source.status, summary });
  type = type || normalizeReportType(undefined, { reason });
  const status = normalizeReportStatus(source.status ?? context.defaultStatus, { reason, type });
  if (!status) {
    throw new Error("Worker report requires a status, reason, report_done/report_blocked type, or recognizable report prefix.");
  }
  if (!reason) reason = normalizeReportReason(undefined, { type, status, summary });
  if (!type) type = normalizeReportType(undefined, { reason });

  const changedFiles = normalizeChangedFiles(source.changedFiles ?? source["changed-files"] ?? source.changed_files ?? source.files);
  const validation = normalizeValidation(source.validation);
  const report = {
    kind: WORKER_REPORT_KIND,
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    runId: source.runId || context.runId,
    taskId: source.taskId || context.taskId,
    type,
    status,
    reason,
    summary,
    changedFiles,
    validation,
    question: toText(source.question),
    correlationId: normalizeCorrelationId(source, context),
    raw: source.raw,
  };
  if (!report.question && report.reason === REPORT_REASON.NEED_DECISION) report.question = report.summary;
  return report;
}

function tryParseWorkerReport(input, context = {}) {
  try {
    return normalizeWorkerReport(input, context);
  } catch (_error) {
    return undefined;
  }
}

function taskStatusForWorkerReport(reportInput) {
  const report = reportInput?.kind === WORKER_REPORT_KIND ? reportInput : normalizeWorkerReport(reportInput);
  if (report.reason === REPORT_REASON.NEED_DECISION) return TASK_STATUS.NEEDS_ATTENTION;
  if (report.reason === REPORT_REASON.ERROR) return TASK_STATUS.NEEDS_ATTENTION;
  if (report.status === TASK_STATUS.BLOCKED) return TASK_STATUS.BLOCKED;
  if (report.status === TASK_STATUS.READY_FOR_REVIEW) return TASK_STATUS.READY_FOR_REVIEW;
  return assertTaskStatus(report.status);
}

function workerReportToTaskTransition(input, context = {}) {
  const report = input?.kind === WORKER_REPORT_KIND ? input : normalizeWorkerReport(input, context);
  const status = taskStatusForWorkerReport(report);
  const now = context.now || context.updatedAt;
  const patch = {
    status,
    workerReport: report,
  };
  if (now) patch.updatedAt = now;
  if (report.summary && isAttentionTaskStatus(status)) patch.error = report.summary;
  if (report.reason === REPORT_REASON.NEED_DECISION) {
    patch.attention = {
      reason: report.reason,
      summary: report.summary,
      question: report.question || report.summary,
      correlationId: report.correlationId,
    };
  } else if (report.reason === REPORT_REASON.BLOCKED) {
    patch.blockedReason = report.summary;
  }
  if (report.changedFiles.length) patch.diff = { changedFiles: report.changedFiles };
  if (report.validation) patch.validation = report.validation;
  return {
    kind: TASK_TRANSITION_KIND,
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    runId: report.runId || context.runId,
    taskId: report.taskId || context.taskId,
    fromStatus: context.fromStatus,
    status,
    reason: report.reason,
    summary: report.summary,
    needsAttention: isAttentionTaskStatus(status),
    report,
    patch,
  };
}

function formatWorkerReportForSupervisor(input, context = {}) {
  const report = input?.kind === WORKER_REPORT_KIND ? input : normalizeWorkerReport(input, context);
  const taskLabel = report.taskId || context.taskId || "Worker";
  const lines = [];
  if (report.reason === REPORT_REASON.NEED_DECISION) {
    lines.push(`${taskLabel} needs a supervisor decision.`);
    if (report.correlationId) lines.push(`Correlation ID: ${report.correlationId}`);
    lines.push("", "Question/request:", report.question || report.summary || "(no question supplied)");
    lines.push("", "Reply with multitask_message using type \"decision\" and the same correlationId when possible.");
  } else if (report.status === TASK_STATUS.READY_FOR_REVIEW) {
    lines.push(`${taskLabel} is ready for review.`);
    if (report.summary) lines.push("", "Summary:", report.summary);
  } else if (report.status === TASK_STATUS.BLOCKED) {
    lines.push(`${taskLabel} is blocked.`);
    if (report.summary) lines.push("", "Blocker:", report.summary);
  } else {
    lines.push(`${taskLabel} needs attention.`);
    if (report.summary) lines.push("", "Summary:", report.summary);
  }
  if (report.changedFiles.length) lines.push("", ...listSection("Changed files:", report.changedFiles));
  const validationLines = formatValidation(report.validation);
  if (validationLines.length) lines.push("", ...validationLines);
  return compactLines(lines);
}

function createWorkerReportMessageDto(input, context = {}) {
  const report = input?.kind === WORKER_REPORT_KIND ? input : normalizeWorkerReport(input, context);
  const type = report.status === TASK_STATUS.READY_FOR_REVIEW ? MESSAGE_TYPE.REPORT_DONE : MESSAGE_TYPE.REPORT_BLOCKED;
  return createMessageDto({
    runId: report.runId || context.runId,
    taskId: report.taskId || context.taskId,
    type,
    direction: MESSAGE_DIRECTION.WORKER_TO_SUPERVISOR,
    mode: MESSAGE_MODE.FOLLOW_UP,
    correlationId: report.correlationId,
    text: report.summary,
    createdAt: context.createdAt,
    payload: {
      status: report.status,
      reason: report.reason,
      summary: report.summary,
      changedFiles: report.changedFiles,
      validation: report.validation,
      question: report.question,
    },
  });
}

module.exports = {
  MESSAGE_ENVELOPE_KIND,
  REPORT_REASON,
  REPORT_REASONS,
  TASK_TRANSITION_KIND,
  WORKER_REPORT_KIND,
  createWorkerReportMessageDto,
  formatDecisionPrompt,
  formatMessageForWorker,
  formatReviewFeedbackPrompt,
  formatWorkerReportForSupervisor,
  normalizeChangedFiles,
  normalizeMessageEnvelope,
  normalizeSupervisorMessage,
  normalizeValidation,
  normalizeWorkerReport,
  taskStatusForWorkerReport,
  tryParseWorkerReport,
  workerReportToTaskTransition,
};
