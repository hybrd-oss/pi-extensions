const { getRepoInfo, git } = require("../git.js");
const { fsp, path, pathExists, slugify } = require("../utils.js");
const { appendRunEvent } = require("./events.js");
const { loadManifest, runDir } = require("./manifest.js");

function isPathInside(parent, child) {
  if (!parent || !child) return false;
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function uniqueTargets(targets) {
  const seen = new Set();
  const result = [];
  for (const target of targets) {
    if (!target?.path) continue;
    const key = path.resolve(target.path);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...target, path: key });
  }
  return result;
}

function collectCleanupTargets(manifest, input = {}) {
  const removeWorktrees = input.removeWorktrees !== false;
  const removeState = input.removeState === true;
  const worktrees = [];
  if (removeWorktrees) {
    for (const task of manifest.tasks || []) {
      if (task.worktree) worktrees.push({ type: "task-worktree", id: task.id, path: task.worktree, branch: task.branch });
    }
    if (manifest.integration?.worktree) {
      worktrees.push({ type: "integration-worktree", id: "integration", path: manifest.integration.worktree, branch: manifest.integration.branch });
    }
  }
  const state = removeState ? [{ type: "run-state", id: manifest.runId, path: manifest.stateDir }] : [];
  return {
    worktrees: uniqueTargets(worktrees),
    state: uniqueTargets(state),
  };
}

function validateCleanupTarget(manifest, target, input = {}) {
  if (input.force === true || target.type === "run-state") return { ok: true };
  const root = manifest.worktreeRoot;
  if (!root) return { ok: false, reason: "manifest has no worktreeRoot; pass force:true to remove worktrees" };
  if (!isPathInside(root, target.path) && path.resolve(root) !== path.resolve(target.path)) {
    return { ok: false, reason: `target is outside worktreeRoot ${root}` };
  }
  return { ok: true };
}

async function removeWorktreeTarget(repoRoot, target, input = {}) {
  if (!(await pathExists(target.path))) return { ...target, status: "missing" };
  if (input.gitWorktreeRemove !== false) {
    const result = await git(repoRoot, ["worktree", "remove", "--force", target.path], {
      allowFailure: true,
      timeoutSeconds: input.timeoutSeconds || 120,
    });
    if (result.exitCode === 0 || !(await pathExists(target.path))) {
      return { ...target, status: "removed", method: "git worktree remove", exitCode: result.exitCode };
    }
    if (input.fallbackRemove === false) {
      return { ...target, status: "failed", method: "git worktree remove", exitCode: result.exitCode, stderr: result.stderr };
    }
  }
  await fsp.rm(target.path, { recursive: true, force: true });
  return { ...target, status: "removed", method: "fs.rm" };
}

async function removeStateTarget(target) {
  if (!(await pathExists(target.path))) return { ...target, status: "missing" };
  await fsp.rm(target.path, { recursive: true, force: true });
  return { ...target, status: "removed", method: "fs.rm" };
}

function summarizeCleanupResult(result) {
  const lines = [`# Multitask Cleanup: ${result.runId}`, ""];
  if (result.dryRun) lines.push("Dry run only; no files were removed.", "");
  const all = [...(result.worktrees || []), ...(result.state || [])];
  if (!all.length) lines.push("No cleanup targets selected.");
  for (const entry of all) {
    lines.push(`- ${entry.status || "planned"} ${entry.type} ${entry.id || ""} ${entry.path}${entry.reason ? ` — ${entry.reason}` : ""}`.trim());
  }
  return lines.join("\n");
}

async function cleanupMultitaskRun(input = {}, options = {}) {
  if (!input.runId) throw new Error("runId is required for multitask cleanup.");
  const repo = options.repo || await getRepoInfo(options.cwd || process.cwd());
  const manifest = options.manifest || await loadManifest(repo.root, slugify(input.runId, "run"));
  const targets = collectCleanupTargets(manifest, input);
  const dryRun = input.dryRun === true;
  const worktrees = [];
  const state = [];

  for (const target of targets.worktrees) {
    const validation = validateCleanupTarget(manifest, target, input);
    if (!validation.ok) {
      worktrees.push({ ...target, status: "skipped", reason: validation.reason });
      continue;
    }
    worktrees.push(dryRun ? { ...target, status: "planned" } : await removeWorktreeTarget(repo.root, target, input));
  }

  for (const target of targets.state) {
    const expected = runDir(repo.root, manifest.runId);
    if (path.resolve(target.path) !== path.resolve(expected) && input.force !== true) {
      state.push({ ...target, status: "skipped", reason: `state path does not match expected ${expected}` });
      continue;
    }
    state.push(dryRun ? { ...target, status: "planned" } : await removeStateTarget(target));
  }

  const result = {
    runId: manifest.runId,
    dryRun,
    worktrees,
    state,
  };
  result.summary = summarizeCleanupResult(result);

  if (!dryRun && !(input.removeState === true)) {
    await appendRunEvent(repo.root, manifest.runId, "run_cleanup_completed", {
      worktrees: worktrees.map((entry) => ({ id: entry.id, status: entry.status, path: entry.path })),
      state: state.map((entry) => ({ id: entry.id, status: entry.status, path: entry.path })),
    }).catch(() => {});
  }

  return result;
}

module.exports = {
  cleanupMultitaskRun,
  collectCleanupTargets,
  isPathInside,
  summarizeCleanupResult,
  validateCleanupTarget,
};
