const { runCommand } = require("./utils.js");

function hookApplies(hook, type) {
  return !Array.isArray(hook.runFor) || hook.runFor.length === 0 || hook.runFor.includes(type);
}

async function runCommandList(commands, cwd, type, context = {}) {
  const results = [];
  for (const command of commands || []) {
    if (!hookApplies(command, type)) {
      results.push({
        name: command.name,
        command: command.command,
        status: "skipped",
        reason: `not configured for ${type}`,
        required: command.required !== false,
      });
      continue;
    }

    const startedAt = new Date().toISOString();
    const env = {
      ...(command.env || {}),
      PI_ORCHESTRATOR_RUN_ID: context.runId,
      PI_ORCHESTRATOR_RUN_DIR: context.runDir,
      PI_ORCHESTRATOR_TASK_ID: context.taskId,
      PI_ORCHESTRATOR_WORKTREE_TYPE: type,
      PI_ORCHESTRATOR_WORKTREE: cwd,
    };
    const result = await runCommand(command.command, [], {
      cwd,
      env,
      shell: true,
      timeoutSeconds: command.timeoutSeconds,
    });
    const status = result.exitCode === 0 ? "succeeded" : "failed";
    const entry = {
      name: command.name,
      command: command.command,
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
      const error = new Error(`Required ${type} command failed: ${command.name}`);
      error.commandResult = entry;
      error.results = results;
      throw error;
    }
  }
  return results;
}

async function runStartupHooks(config, cwd, type, context) {
  return runCommandList(config.worktrees.startupHooks, cwd, type, context);
}

async function runValidationCommands(config, cwd, type, context) {
  const list = type === "integration" ? config.validation.integration : config.validation.worker;
  return runCommandList(list, cwd, type, context);
}

function summarizeCommandResults(results) {
  if (!results || results.length === 0) return "none";
  return results
    .map((r) => {
      if (r.status === "skipped") return `- ${r.name}: skipped (${r.reason})`;
      return `- ${r.name}: ${r.status}${typeof r.exitCode === "number" ? ` (exit ${r.exitCode})` : ""}`;
    })
    .join("\n");
}

module.exports = { hookApplies, runCommandList, runStartupHooks, runValidationCommands, summarizeCommandResults };
