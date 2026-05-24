const { path, runCommand } = require("./utils.js");

function hookApplies(hook, type) {
  return !Array.isArray(hook.runFor) || hook.runFor.length === 0 || hook.runFor.includes(type);
}

function resolveScriptCwd(worktreeRoot, command) {
  if (!command.cwd) return worktreeRoot;
  return path.isAbsolute(command.cwd) ? command.cwd : path.resolve(worktreeRoot, command.cwd);
}

async function runCommandList(commands, worktreeRoot, type, context = {}) {
  const results = [];
  for (const command of commands || []) {
    if (!hookApplies(command, type)) {
      results.push({
        id: command.id,
        name: command.name,
        command: command.command,
        cwd: command.cwd,
        status: "skipped",
        reason: `not configured for ${type}`,
        required: command.required !== false,
      });
      continue;
    }

    const commandCwd = resolveScriptCwd(worktreeRoot, command);
    const startedAt = new Date().toISOString();
    const env = {
      ...(command.env || {}),
      PI_MULTITASK_RUN_ID: context.runId,
      PI_MULTITASK_RUN_DIR: context.runDir,
      PI_MULTITASK_TASK_ID: context.taskId,
      PI_MULTITASK_WORKTREE_TYPE: type,
      PI_MULTITASK_WORKTREE: worktreeRoot,
    };
    const result = await runCommand(command.command, [], {
      cwd: commandCwd,
      env,
      shell: true,
      timeoutSeconds: command.timeoutSeconds,
    });
    const status = result.exitCode === 0 ? "succeeded" : "failed";
    const entry = {
      id: command.id,
      name: command.name,
      command: command.command,
      cwd: command.cwd || ".",
      resolvedCwd: commandCwd,
      status,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      required: command.required !== false,
    };
    results.push(entry);
    if (status === "failed" && command.required !== false) {
      const error = new Error(`Required ${type} script failed: ${command.id || command.name}`);
      error.commandResult = entry;
      error.results = results;
      throw error;
    }
  }
  return results;
}

async function runStartupScripts(_config, cwd, type, context, scripts) {
  return runCommandList(scripts, cwd, type, context);
}

async function runValidationScripts(_config, cwd, type, context, scripts) {
  return runCommandList(scripts, cwd, type, context);
}

function summarizeCommandResults(results) {
  if (!results || results.length === 0) return "none";
  return results
    .map((r) => {
      const label = r.id || r.name;
      if (r.status === "skipped") return `- ${label}: skipped (${r.reason})`;
      return `- ${label}: ${r.status}${typeof r.exitCode === "number" ? ` (exit ${r.exitCode})` : ""}`;
    })
    .join("\n");
}

module.exports = {
  hookApplies,
  resolveScriptCwd,
  runCommandList,
  runStartupScripts,
  runValidationScripts,
  summarizeCommandResults,
};
