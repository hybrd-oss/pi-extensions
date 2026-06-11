const { getRepoInfo } = require("../git.js");
const { ensureDir, fsp, path, pathExists, slugify } = require("../utils.js");
const { getDiff } = require("./diff.js");
const {
  loadManifest,
  planPath,
  runDir,
  runEventsPath,
  taskEventsPath,
  taskReviewPath,
  taskStdoutPath,
  taskStderrPath,
  taskTranscriptPath,
} = require("./manifest.js");

const EXPORT_SCHEMA_VERSION = 1;
const DEFAULT_EXPORT_LIMITS = Object.freeze({
  runEventEntries: 2000,
  taskEventEntries: 1000,
  transcriptEntries: 200,
  transcriptBytes: 2 * 1024 * 1024,
  rawLineChars: 20_000,
});

function exportTimestampForPath(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/T/, "-").replace(/\..+$/, "Z");
}

function defaultExportPath(repoRoot, runId, options = {}) {
  const stamp = exportTimestampForPath(options.date || new Date());
  return path.join(runDir(repoRoot, runId), `export-${slugify(runId, "run")}-${stamp}.json`);
}

async function fileInfo(file) {
  if (!file || !(await pathExists(file))) return { exists: false, path: file };
  const stat = await fsp.stat(file);
  return { exists: true, path: file, bytes: stat.size, modifiedAt: stat.mtime.toISOString() };
}

function truncateString(value, maxChars = DEFAULT_EXPORT_LIMITS.rawLineChars) {
  const text = String(value ?? "");
  if (!maxChars || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[... truncated ${text.length - maxChars} chars ...]`;
}

function truncateJsonValue(value, maxChars = DEFAULT_EXPORT_LIMITS.rawLineChars) {
  if (typeof value === "string") return truncateString(value, maxChars);
  if (Array.isArray(value)) return value.map((item) => truncateJsonValue(item, maxChars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, truncateJsonValue(item, maxChars)]));
  }
  return value;
}

function parseJsonLine(line, source, options = {}) {
  try {
    return truncateJsonValue(JSON.parse(line), options.maxRawChars || DEFAULT_EXPORT_LIMITS.rawLineChars);
  } catch (error) {
    return {
      time: new Date().toISOString(),
      type: "malformed_event",
      source,
      raw: truncateString(line, options.maxRawChars || 2000),
      error: error.message,
    };
  }
}

async function readJsonLinesCapped(file, options = {}) {
  const info = await fileInfo(file);
  if (!info.exists) return { entries: [], info };

  const lineLimit = Number(options.lines || 0);
  const maxBytes = Number(options.maxBytes || 0);
  const shouldTail = maxBytes > 0 && info.bytes > maxBytes;
  let raw;
  if (shouldTail) {
    const handle = await fsp.open(file, "r");
    try {
      const buffer = Buffer.alloc(maxBytes);
      await handle.read(buffer, 0, maxBytes, Math.max(0, info.bytes - maxBytes));
      raw = buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } else {
    raw = await fsp.readFile(file, "utf8");
  }

  let lines = raw.split(/\r?\n/).filter((line) => line.trim());
  if (shouldTail && lines.length) lines = lines.slice(1);
  if (lineLimit > 0) lines = lines.slice(-lineLimit);
  return {
    entries: lines.map((line) => parseJsonLine(line, file, options)),
    info: {
      ...info,
      truncated: shouldTail || (lineLimit > 0 && lines.length >= lineLimit),
      tailBytes: shouldTail ? maxBytes : undefined,
      entryLimit: lineLimit || undefined,
      exportedEntries: lines.length,
    },
  };
}

async function readTextIfExists(file, options = {}) {
  if (!file || !(await pathExists(file))) return undefined;
  const maxBytes = Number(options.maxBytes || 0);
  if (maxBytes > 0) {
    const stat = await fsp.stat(file);
    if (stat.size > maxBytes) {
      const handle = await fsp.open(file, "r");
      try {
        const headBytes = Math.floor(maxBytes * 0.6);
        const tailBytes = Math.max(0, maxBytes - headBytes);
        const head = Buffer.alloc(headBytes);
        await handle.read(head, 0, headBytes, 0);
        const tail = Buffer.alloc(tailBytes);
        await handle.read(tail, 0, tailBytes, Math.max(0, stat.size - tailBytes));
        return `${head.toString("utf8")}\n\n[... export truncated ${stat.size - maxBytes} bytes ...]\n\n${tail.toString("utf8")}`;
      } finally {
        await handle.close();
      }
    }
  }
  return fsp.readFile(file, "utf8");
}

function exportLimits(input = {}) {
  const fullTranscripts = input.includeFullTranscripts === true;
  return {
    runEventEntries: Number(input.maxRunEventEntries || DEFAULT_EXPORT_LIMITS.runEventEntries),
    taskEventEntries: Number(input.maxTaskEventEntries || DEFAULT_EXPORT_LIMITS.taskEventEntries),
    transcriptEntries: fullTranscripts ? 0 : Number(input.maxTranscriptEntries || DEFAULT_EXPORT_LIMITS.transcriptEntries),
    transcriptBytes: fullTranscripts ? 0 : Number(input.maxTranscriptBytes || DEFAULT_EXPORT_LIMITS.transcriptBytes),
    rawLineChars: Number(input.maxRawLineChars || DEFAULT_EXPORT_LIMITS.rawLineChars),
    includeFullTranscripts: fullTranscripts,
  };
}

async function collectTaskExport(repoRoot, manifest, task, options = {}) {
  const runId = manifest.runId;
  const taskId = task.id;
  const reviewPath = task.reviewPath || taskReviewPath(repoRoot, runId, taskId);
  const stdoutPath = taskStdoutPath(repoRoot, runId, taskId);
  const stderrPath = taskStderrPath(repoRoot, runId, taskId);
  const transcriptPath = taskTranscriptPath(repoRoot, runId, taskId);
  const eventsPath = taskEventsPath(repoRoot, runId, taskId);

  const limits = exportLimits(options);
  const taskEvents = await readJsonLinesCapped(eventsPath, {
    lines: limits.taskEventEntries,
    maxRawChars: limits.rawLineChars,
  });
  const transcript = await readJsonLinesCapped(transcriptPath, {
    lines: limits.transcriptEntries,
    maxBytes: limits.transcriptBytes,
    maxRawChars: limits.rawLineChars,
  });

  const taskExport = {
    taskId,
    manifest: task,
    paths: {
      events: eventsPath,
      transcript: transcriptPath,
      review: reviewPath,
      stdout: stdoutPath,
      stderr: stderrPath,
      worktree: task.worktree,
      session: task.paths?.session || task.worker?.sessionDir,
    },
    events: taskEvents.entries,
    eventInfo: taskEvents.info,
    transcript: transcript.entries,
    transcriptInfo: transcript.info,
    review: {
      path: reviewPath,
      markdown: await readTextIfExists(reviewPath),
      metadata: task.review,
    },
  };

  if (options.includeLogs === true) {
    taskExport.logs = {
      stdout: await readTextIfExists(stdoutPath, { maxBytes: options.maxLogBytes || 1024 * 1024 }),
      stderr: await readTextIfExists(stderrPath, { maxBytes: options.maxLogBytes || 1024 * 1024 }),
    };
  }

  return taskExport;
}

async function collectDiffs(repoRoot, manifest, input = {}, options = {}) {
  if (input.includeDiffs === false) return undefined;
  const getRunDiff = options.getDiff || getDiff;
  try {
    return await getRunDiff({ runId: manifest.runId, ...(input.diffOptions || {}) }, {
      cwd: repoRoot,
      repo: { root: repoRoot, branch: manifest.baseBranch, baseCommit: manifest.baseCommit },
      manifest,
    });
  } catch (error) {
    return {
      runId: manifest.runId,
      error: {
        name: error.name || "Error",
        message: error.message || String(error),
      },
      summary: `Diff export failed: ${error.message || String(error)}`,
    };
  }
}

function collectIntegrationMetadata(manifest, diffs) {
  const integrationDiff = Array.isArray(diffs?.targets)
    ? diffs.targets.find((target) => target.targetType === "integration" || target.targetId === "integration")
    : undefined;
  return {
    manifest: manifest.integration,
    branch: manifest.integration?.branch,
    worktree: manifest.integration?.worktree,
    status: manifest.integration?.status,
    startupResults: manifest.integration?.startupResults || [],
    validation: manifest.integration?.validation || [],
    merges: manifest.integration?.merges || [],
    apply: manifest.integration?.apply,
    diff: integrationDiff,
  };
}

async function collectRunExport(input = {}, options = {}) {
  if (!input.runId) throw new Error("runId is required for multitask export.");
  const repo = options.repo || await getRepoInfo(options.cwd || process.cwd());
  const runId = slugify(input.runId, "run");
  const manifest = options.manifest || await loadManifest(repo.root, runId);
  const limits = exportLimits(input);
  const planFile = planPath(repo.root, manifest.runId);
  const runEventsFile = runEventsPath(repo.root, manifest.runId);
  const runEvents = await readJsonLinesCapped(runEventsFile, {
    lines: limits.runEventEntries,
    maxRawChars: limits.rawLineChars,
  });
  const tasks = [];
  for (const task of manifest.tasks || []) tasks.push(await collectTaskExport(repo.root, manifest, task, input));
  const diffs = await collectDiffs(repo.root, manifest, input, options);

  return {
    kind: "pi-multitask-run-export",
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    runId: manifest.runId,
    repoRoot: repo.root,
    manifest,
    plan: {
      path: planFile,
      markdown: await readTextIfExists(planFile),
    },
    events: {
      path: runEventsFile,
      entries: runEvents.entries,
      info: runEvents.info,
    },
    tasks,
    transcripts: Object.fromEntries(tasks.map((task) => [task.taskId, task.transcript])),
    reviews: Object.fromEntries(tasks.map((task) => [task.taskId, task.review])),
    diffs,
    integration: collectIntegrationMetadata(manifest, diffs),
    limits,
    files: {
      runDir: runDir(repo.root, manifest.runId),
      manifest: path.join(runDir(repo.root, manifest.runId), "manifest.json"),
      plan: planFile,
      events: runEventsFile,
    },
  };
}

async function writeExportBundle(bundle, outputPath) {
  if (!outputPath) return undefined;
  await ensureDir(path.dirname(outputPath));
  await fsp.writeFile(outputPath, JSON.stringify(bundle, null, 2) + "\n", "utf8");
  return outputPath;
}

async function exportMultitaskRun(input = {}, options = {}) {
  const bundle = await collectRunExport(input, options);
  const repoRoot = bundle.repoRoot;
  let outputPath = input.outputPath || options.outputPath;
  if (!outputPath && input.outputDir) outputPath = path.join(input.outputDir, path.basename(defaultExportPath(repoRoot, bundle.runId)));
  if (!outputPath && input.write !== false && options.write !== false) outputPath = defaultExportPath(repoRoot, bundle.runId);
  if (outputPath) bundle.outputPath = outputPath;
  bundle.summary = summarizeRunExport(bundle);
  if (outputPath) await writeExportBundle(bundle, outputPath);
  return bundle;
}

function summarizeRunExport(bundle = {}) {
  const taskCount = (bundle.tasks || []).length;
  const eventCount = bundle.events?.entries?.length || 0;
  const transcriptCount = (bundle.tasks || []).reduce((count, task) => count + (task.transcript?.length || 0), 0);
  const reviewCount = (bundle.tasks || []).filter((task) => task.review?.markdown || task.review?.metadata).length;
  const diffStatus = bundle.diffs?.error ? "diff failed" : bundle.diffs ? "diff included" : "diff skipped";
  return `Exported run ${bundle.runId}: ${taskCount} task(s), ${eventCount} run event(s), ${transcriptCount} transcript entries, ${reviewCount} review(s), ${diffStatus}.`;
}

function compactRunExportResult(bundle = {}) {
  return {
    kind: bundle.kind,
    schemaVersion: bundle.schemaVersion,
    exportedAt: bundle.exportedAt,
    runId: bundle.runId,
    repoRoot: bundle.repoRoot,
    outputPath: bundle.outputPath,
    summary: bundle.summary || summarizeRunExport(bundle),
    formatted: formatRunExportSummary(bundle),
    limits: bundle.limits,
    counts: {
      tasks: (bundle.tasks || []).length,
      runEvents: bundle.events?.entries?.length || 0,
      transcriptEntries: (bundle.tasks || []).reduce((count, task) => count + (task.transcript?.length || 0), 0),
      reviews: (bundle.tasks || []).filter((task) => task.review?.markdown || task.review?.metadata).length,
    },
    files: bundle.files,
    taskFiles: Object.fromEntries((bundle.tasks || []).map((task) => [task.taskId, {
      paths: task.paths,
      eventInfo: task.eventInfo,
      transcriptInfo: task.transcriptInfo,
    }])),
    integration: {
      status: bundle.integration?.status,
      branch: bundle.integration?.branch,
      worktree: bundle.integration?.worktree,
      validation: bundle.integration?.validation,
      merges: bundle.integration?.merges,
      apply: bundle.integration?.apply,
    },
  };
}

function formatRunExportSummary(bundle = {}) {
  const lines = [
    `# Porchestrator Export: ${bundle.runId}`,
    "",
    bundle.summary || summarizeRunExport(bundle),
  ];
  if (bundle.outputPath) lines.push(`Output: ${bundle.outputPath}`);
  lines.push("", "Contents:");
  lines.push(`- manifest: yes`);
  lines.push(`- plan: ${bundle.plan?.markdown === undefined ? "missing" : "included"}`);
  lines.push(`- events: ${bundle.events?.entries?.length || 0}`);
  lines.push(`- transcripts: ${(bundle.tasks || []).reduce((count, task) => count + (task.transcript?.length ? 1 : 0), 0)} task(s)`);
  lines.push(`- reviews: ${(bundle.tasks || []).filter((task) => task.review?.markdown || task.review?.metadata).length}`);
  lines.push(`- diffs: ${bundle.diffs?.error ? `failed (${bundle.diffs.error.message})` : bundle.diffs ? "included" : "skipped"}`);
  if (bundle.integration?.status) lines.push(`- integration: ${bundle.integration.status}`);
  return lines.join("\n");
}

module.exports = {
  EXPORT_SCHEMA_VERSION,
  collectRunExport,
  collectTaskExport,
  compactRunExportResult,
  defaultExportPath,
  exportMultitaskRun,
  formatRunExportSummary,
  readJsonLinesCapped,
  summarizeRunExport,
  writeExportBundle,
};
