const { path, runCommand, slugify } = require("./utils.js");

async function git(cwd, args, options = {}) {
  const result = await runCommand("git", args, { cwd, timeoutSeconds: options.timeoutSeconds ?? 120, signal: options.signal });
  if (options.allowFailure) return result;
  if (result.exitCode !== 0) {
    const message = [`git ${args.join(" ")} failed with exit code ${result.exitCode}`];
    if (result.stdout) message.push(`stdout:\n${result.stdout}`);
    if (result.stderr) message.push(`stderr:\n${result.stderr}`);
    const error = new Error(message.join("\n"));
    error.result = result;
    throw error;
  }
  return result;
}

async function getRepoInfo(cwd) {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
  const baseCommit = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  const branchResult = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true });
  const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : "HEAD";
  return { root, baseCommit, branch };
}

async function getRefCommit(cwd, ref) {
  return (await git(cwd, ["rev-parse", ref])).stdout.trim();
}

async function requireCleanRepo(cwd) {
  const result = await git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  if (result.stdout.trim()) {
    const error = new Error(
      [
        "Repository has uncommitted or untracked changes. Commit or stash planning/spec changes before dispatching orchestrator workers.",
        result.stdout.trim(),
      ].join("\n"),
    );
    error.status = result.stdout;
    throw error;
  }
}

function branchFor(runId, taskId) {
  return `orch/${slugify(runId, "run")}/${slugify(taskId, "task")}`;
}

function worktreePathFor(worktreeRoot, runId, taskId) {
  return path.join(worktreeRoot, slugify(runId, "run"), slugify(taskId, "task"));
}

async function branchExists(cwd, branch) {
  const result = await git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { allowFailure: true });
  return result.exitCode === 0;
}

async function commitExists(cwd, commit) {
  if (!commit) return false;
  const result = await git(cwd, ["cat-file", "-e", `${commit}^{commit}`], { allowFailure: true });
  return result.exitCode === 0;
}

async function createWorktree(repoRoot, worktreePath, branch, baseRef, options = {}) {
  const args = ["worktree", "add"];
  if (options.force) args.push("--force");
  args.push("-b", branch, worktreePath, baseRef);
  return git(repoRoot, args, { timeoutSeconds: options.timeoutSeconds ?? 180 });
}

async function removeWorktree(repoRoot, worktreePath, options = {}) {
  return git(repoRoot, ["worktree", "remove", options.force === false ? "" : "--force", worktreePath].filter(Boolean), {
    allowFailure: options.allowFailure ?? true,
    timeoutSeconds: 180,
  });
}

async function getCurrentCommit(cwd) {
  return (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
}

async function isDirty(cwd) {
  const result = await git(cwd, ["status", "--porcelain", "--untracked-files=all"], { allowFailure: true });
  return result.exitCode !== 0 || Boolean(result.stdout.trim());
}

async function mergeBranch(cwd, branch) {
  return git(cwd, ["merge", "--no-ff", branch, "-m", `orchestrator: merge ${branch}`], {
    allowFailure: true,
    timeoutSeconds: 300,
  });
}

async function addAndCommit(cwd, paths, message) {
  const files = Array.isArray(paths) && paths.length > 0 ? paths : ["-A"];
  await git(cwd, ["add", ...files]);
  const diff = await git(cwd, ["diff", "--cached", "--quiet"], { allowFailure: true });
  if (diff.exitCode === 0) return { committed: false, commit: await getCurrentCommit(cwd) };
  await git(cwd, ["commit", "-m", message], { timeoutSeconds: 180 });
  return { committed: true, commit: await getCurrentCommit(cwd) };
}

module.exports = {
  addAndCommit,
  branchExists,
  branchFor,
  commitExists,
  createWorktree,
  getCurrentCommit,
  getRefCommit,
  getRepoInfo,
  git,
  isDirty,
  mergeBranch,
  removeWorktree,
  requireCleanRepo,
  worktreePathFor,
};
