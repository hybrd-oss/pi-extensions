const { branchExists, getCurrentCommit, getRepoInfo, git } = require("../git.js");
const { pathExists, relPath, slugify } = require("../utils.js");
const { loadManifest } = require("./manifest.js");

function selectTask(manifest, taskId) {
  const normalized = slugify(taskId, "task");
  const task = (manifest.tasks || []).find((candidate) => candidate.id === normalized || candidate.id === taskId);
  if (!task) throw new Error(`No multitask task ${taskId} in run ${manifest.runId}.`);
  return task;
}

function integrationTarget(manifest) {
  if (!manifest.integration) throw new Error(`Run ${manifest.runId} has no integration target.`);
  return manifest.integration;
}

function normalizeBaseRef(manifest, input = {}) {
  return input.baseRef || manifest.baseCommit || manifest.baseRef || "HEAD";
}

function parseNameStatus(text, source) {
  const entries = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0];
    const isRenameOrCopy = /^[RC]/.test(status);
    const filePath = isRenameOrCopy ? parts[2] : parts[1];
    if (!filePath) continue;
    entries.push({
      path: filePath,
      oldPath: isRenameOrCopy ? parts[1] : undefined,
      status,
      source,
    });
  }
  return entries;
}

function parsePorcelainStatusZ(text) {
  const chunks = String(text || "").split("\0").filter(Boolean);
  const entries = [];
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    if (chunk.length < 4) continue;
    const status = chunk.slice(0, 2);
    const filePath = chunk.slice(3);
    const entry = { path: filePath, status, source: "worktree" };
    if (status.includes("R") || status.includes("C")) {
      entry.oldPath = chunks[index + 1];
      index++;
    }
    entries.push(entry);
  }
  return entries;
}

function mergeChangedFiles(...lists) {
  const byPath = new Map();
  for (const list of lists) {
    for (const entry of list || []) {
      if (!entry?.path) continue;
      const existing = byPath.get(entry.path);
      if (!existing) {
        byPath.set(entry.path, { ...entry, sources: [entry.source].filter(Boolean) });
        continue;
      }
      if (entry.oldPath && !existing.oldPath) existing.oldPath = entry.oldPath;
      if (entry.status && !String(existing.status || "").includes(entry.status)) {
        existing.status = [existing.status, entry.status].filter(Boolean).join("+");
      }
      if (entry.source && !existing.sources.includes(entry.source)) existing.sources.push(entry.source);
    }
  }
  return Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
}

function hasUnmergedStatus(entry) {
  const status = String(entry?.status || "");
  return status.includes("U") || status === "AA" || status === "DD";
}

async function runGit(cwd, args, errors, label) {
  const result = await git(cwd, args, { allowFailure: true, timeoutSeconds: 120 });
  if (result.exitCode !== 0) {
    errors.push({ label, args, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
  }
  return result;
}

async function collectWorktreeDiff(target, context) {
  const { baseRef, errors } = context;
  const cwd = target.worktree;
  const head = await getCurrentCommit(cwd).catch(() => undefined);
  const committedName = await runGit(cwd, ["diff", "--name-status", baseRef, "HEAD", "--"], errors, "committed name-status");
  const committedStat = await runGit(cwd, ["diff", "--stat", baseRef, "HEAD", "--"], errors, "committed stat");
  const committedShortstat = await runGit(cwd, ["diff", "--shortstat", baseRef, "HEAD", "--"], errors, "committed shortstat");
  const stagedName = await runGit(cwd, ["diff", "--name-status", "--cached", "--"], errors, "staged name-status");
  const unstagedName = await runGit(cwd, ["diff", "--name-status", "--", "."], errors, "unstaged name-status");
  const workingStat = await runGit(cwd, ["diff", "--stat", "HEAD", "--"], errors, "working stat");
  const workingShortstat = await runGit(cwd, ["diff", "--shortstat", "HEAD", "--"], errors, "working shortstat");
  const status = await runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], errors, "worktree status");
  const statusEntries = parsePorcelainStatusZ(status.stdout);
  const changedFiles = mergeChangedFiles(
    parseNameStatus(committedName.stdout, "committed"),
    parseNameStatus(stagedName.stdout, "staged"),
    parseNameStatus(unstagedName.stdout, "unstaged"),
    statusEntries,
  );

  return {
    head,
    worktreeExists: true,
    branchExists: target.branch ? await branchExists(cwd, target.branch).catch(() => false) : undefined,
    changedFiles,
    statusEntries,
    committed: {
      nameStatus: committedName.stdout,
      stat: committedStat.stdout,
      shortstat: committedShortstat.stdout.trim(),
    },
    workingTree: {
      status: statusEntries,
      stat: workingStat.stdout,
      shortstat: workingShortstat.stdout.trim(),
    },
  };
}

async function collectBranchDiff(repoRoot, target, context) {
  const { baseRef, errors } = context;
  const exists = target.branch ? await branchExists(repoRoot, target.branch).catch(() => false) : false;
  if (!exists) {
    return {
      head: undefined,
      worktreeExists: false,
      branchExists: false,
      changedFiles: [],
      statusEntries: [],
      committed: { nameStatus: "", stat: "", shortstat: "" },
      workingTree: { status: [], stat: "", shortstat: "" },
    };
  }

  const headResult = await runGit(repoRoot, ["rev-parse", target.branch], errors, "branch head");
  const committedName = await runGit(repoRoot, ["diff", "--name-status", baseRef, target.branch, "--"], errors, "branch name-status");
  const committedStat = await runGit(repoRoot, ["diff", "--stat", baseRef, target.branch, "--"], errors, "branch stat");
  const committedShortstat = await runGit(repoRoot, ["diff", "--shortstat", baseRef, target.branch, "--"], errors, "branch shortstat");

  return {
    head: headResult.stdout.trim() || undefined,
    worktreeExists: false,
    branchExists: true,
    changedFiles: mergeChangedFiles(parseNameStatus(committedName.stdout, "branch")),
    statusEntries: [],
    committed: {
      nameStatus: committedName.stdout,
      stat: committedStat.stdout,
      shortstat: committedShortstat.stdout.trim(),
    },
    workingTree: { status: [], stat: "", shortstat: "" },
  };
}

function formatChangedFiles(changedFiles) {
  if (!changedFiles.length) return ["No changed files detected."];
  return changedFiles.map((file) => {
    const sources = file.sources?.length ? ` (${file.sources.join(", ")})` : "";
    const rename = file.oldPath ? ` from ${file.oldPath}` : "";
    return `- ${file.status || "?"} ${file.path}${rename}${sources}`;
  });
}

function formatSingleDiffSummary(diff, options = {}) {
  const repoRoot = options.repoRoot || diff.repoRoot;
  const relWorktree = diff.worktree && repoRoot ? relPath(repoRoot, diff.worktree) : diff.worktree;
  const lines = [
    `# Multitask Diff: ${diff.runId}/${diff.targetId}`,
    "",
    `Target: ${diff.targetType}`,
    `Base: ${diff.baseRef}`,
    `Head: ${diff.head || "(missing)"}`,
    `Branch: ${diff.branch || "(none)"}${diff.branchExists === false ? " (missing)" : ""}`,
    `Worktree: ${relWorktree || "(none)"}${diff.worktreeExists === false ? " (missing)" : ""}`,
    `Changed files: ${diff.changedFiles.length}`,
    "",
    "## Files",
    ...formatChangedFiles(diff.changedFiles),
  ];
  if (diff.committed?.shortstat) lines.push("", "## Committed/branch shortstat", diff.committed.shortstat);
  if (diff.workingTree?.shortstat) lines.push("", "## Working tree shortstat", diff.workingTree.shortstat);
  if (diff.unmergedFiles?.length) lines.push("", "## Unmerged paths", ...diff.unmergedFiles.map((file) => `- ${file.status} ${file.path}`));
  if (diff.errors?.length) lines.push("", "## Git warnings", ...diff.errors.map((error) => `- ${error.label}: exit ${error.exitCode}${error.stderr ? ` — ${error.stderr.trim()}` : ""}`));
  return lines.join("\n");
}

function formatRunDiffSummary(runDiff, options = {}) {
  const lines = [`# Multitask Diff: ${runDiff.runId}`, ""];
  if (!runDiff.targets.length) lines.push("No targets found.");
  for (const target of runDiff.targets) {
    lines.push(`- ${target.targetId} (${target.targetType}): ${target.changedFiles.length} changed file(s)${target.branchExists === false ? " · branch missing" : ""}${target.worktreeExists === false ? " · worktree missing" : ""}`);
  }
  lines.push("");
  for (const target of runDiff.targets) {
    lines.push(formatSingleDiffSummary(target, options), "");
  }
  return lines.join("\n").trim();
}

async function getTargetDiff(repoRoot, manifest, target, targetType, options = {}) {
  const baseRef = normalizeBaseRef(manifest, options);
  const errors = [];
  const worktreeExists = target.worktree ? await pathExists(target.worktree) : false;
  const collected = worktreeExists
    ? await collectWorktreeDiff(target, { baseRef, errors })
    : await collectBranchDiff(repoRoot, target, { baseRef, errors });
  const unmergedFiles = (collected.statusEntries || []).filter(hasUnmergedStatus);
  const diff = {
    runId: manifest.runId,
    targetId: target.id || targetType,
    targetType,
    repoRoot,
    baseRef,
    branch: target.branch,
    worktree: target.worktree,
    errors,
    ...collected,
    unmergedFiles,
  };
  diff.summary = formatSingleDiffSummary(diff, { repoRoot });
  return diff;
}

async function getTaskDiff(repoRoot, manifest, task, options = {}) {
  return getTargetDiff(repoRoot, manifest, task, "task", options);
}

async function getIntegrationDiff(repoRoot, manifest, options = {}) {
  return getTargetDiff(repoRoot, manifest, integrationTarget(manifest), "integration", options);
}

async function getDiff(input = {}, options = {}) {
  if (!input.runId) throw new Error("runId is required for multitask diff.");
  const repo = options.repo || await getRepoInfo(options.cwd || process.cwd());
  const manifest = options.manifest || await loadManifest(repo.root, slugify(input.runId, "run"));

  if (input.taskId) {
    const diff = await getTaskDiff(repo.root, manifest, selectTask(manifest, input.taskId), input);
    return { ...diff, manifest, summary: diff.summary };
  }
  if (input.integration) {
    const diff = await getIntegrationDiff(repo.root, manifest, input);
    return { ...diff, manifest, summary: diff.summary };
  }

  const targets = [];
  for (const task of manifest.tasks || []) targets.push(await getTaskDiff(repo.root, manifest, task, input));
  if (manifest.integration) targets.push(await getIntegrationDiff(repo.root, manifest, input));
  const runDiff = { runId: manifest.runId, manifest, targets };
  runDiff.summary = formatRunDiffSummary(runDiff, { repoRoot: repo.root });
  return runDiff;
}

module.exports = {
  formatRunDiffSummary,
  formatSingleDiffSummary,
  getDiff,
  getIntegrationDiff,
  getTargetDiff,
  getTaskDiff,
  mergeChangedFiles,
  parseNameStatus,
  parsePorcelainStatusZ,
};
