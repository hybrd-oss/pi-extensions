const { spawn } = require("node:child_process");
const { fsp, os, path, runCommand, slugify, truncateMiddle } = require("./utils.js");
const { addAndCommit, getCurrentCommit } = require("./git.js");
const { summarizeCommandResults } = require("./hooks.js");

function getPiInvocation(args) {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript) {
    try {
      if (require("node:fs").existsSync(currentScript)) return { command: process.execPath, args: [currentScript, ...args] };
    } catch {
      // Fall through.
    }
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };
  return { command: "pi", args };
}

function loadAgentPrompt(agentName) {
  const name = slugify(agentName || "worker", "worker");
  const candidate = path.resolve(__dirname, "..", "agents", `${name}.md`);
  try {
    const raw = require("node:fs").readFileSync(candidate, "utf8");
    return raw.replace(/^---[\s\S]*?---\s*/, "");
  } catch {
    const fallback = path.resolve(__dirname, "..", "agents", "worker.md");
    try {
      return require("node:fs").readFileSync(fallback, "utf8").replace(/^---[\s\S]*?---\s*/, "");
    } catch {
      return "You are an implementation worker. Complete the delegated task, validate it, commit your changes, and report a concise summary.";
    }
  }
}

function buildWorkerPrompt(input) {
  return [
    loadAgentPrompt(input.agent || "worker"),
    "",
    "# Orchestrator Worker Context",
    `Run ID: ${input.runId}`,
    `Task ID: ${input.taskId}`,
    `Branch: ${input.branch || "(none)"}`,
    `Worktree: ${input.cwd}`,
    "",
    "Worktree setup completed.",
    "Startup hooks:",
    summarizeCommandResults(input.startupHooks),
    "",
    "# Delegated Task",
    input.task,
    "",
    "# Required Completion Contract",
    "- Implement only this task's scope unless coordination is explicitly required.",
    "- Run relevant validation commands when practical.",
    "- Commit your changes before finishing. Use a concise message such as `orchestrator: complete <task-id>`.",
    "- Finish with Markdown sections: `## Completed`, `## Files Changed`, `## Validation`, `## Commit`, and `## Notes`.",
  ].join("\n");
}

class PiSubprocessWorkerRunner {
  constructor(options = {}) {
    this.model = options.model;
    this.tools = options.tools || ["read", "bash", "edit", "write", "grep", "find", "ls"];
    this.allowWorkerDelegation = options.allowWorkerDelegation === true;
  }

  async runWorker(input) {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-worker-"));
    const promptPath = path.join(tmpDir, "worker-prompt.md");
    await fsp.writeFile(promptPath, buildWorkerPrompt(input), { encoding: "utf8", mode: 0o600 });

    const args = ["--mode", "json", "-p", "--no-session", "--append-system-prompt", promptPath];
    if (this.model || input.model) args.push("--model", input.model || this.model);
    if (!this.allowWorkerDelegation && this.tools?.length) args.push("--tools", this.tools.join(","));
    args.push(`Task: ${input.task}`);

    const current = {
      status: "running",
      exitCode: null,
      stdout: "",
      stderr: "",
      output: "",
      messages: [],
      usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    };

    try {
      const invocation = getPiInvocation(args);
      const result = await new Promise((resolve) => {
        const proc = spawn(invocation.command, invocation.args, {
          cwd: input.cwd,
          env: { ...process.env, PI_ORCHESTRATOR_ROLE: "worker" },
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let buffer = "";
        const processLine = (line) => {
          if (!line.trim()) return;
          current.stdout += line + "\n";
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            return;
          }
          if (event.type === "message_end" && event.message) {
            current.messages.push(event.message);
            if (event.message.role === "assistant") {
              current.usage.turns++;
              for (const part of event.message.content || []) {
                if (part.type === "text") current.output = part.text;
              }
              const usage = event.message.usage || {};
              current.usage.input += usage.input || 0;
              current.usage.output += usage.output || 0;
              current.usage.cacheRead += usage.cacheRead || 0;
              current.usage.cacheWrite += usage.cacheWrite || 0;
              current.usage.cost += usage.cost?.total || 0;
            }
          }
        };
        proc.stdout.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) processLine(line);
        });
        proc.stderr.on("data", (chunk) => {
          current.stderr += chunk.toString();
        });
        proc.on("error", (error) => {
          current.stderr += error.message;
          resolve({ exitCode: 1 });
        });
        proc.on("close", (code) => {
          if (buffer.trim()) processLine(buffer);
          resolve({ exitCode: code ?? 0 });
        });
        if (input.signal) {
          const abort = () => proc.kill("SIGTERM");
          if (input.signal.aborted) abort();
          else input.signal.addEventListener("abort", abort, { once: true });
        }
      });

      const commit = await getCurrentCommit(input.cwd).catch(() => undefined);
      return {
        status: result.exitCode === 0 ? "completed" : "failed",
        exitCode: result.exitCode,
        summary: current.output || current.stderr || "(no worker output)",
        output: current.output,
        stderr: truncateMiddle(current.stderr),
        commit,
        usage: current.usage,
        messages: current.messages,
      };
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  }

  describeWorkerCommand(input) {
    const args = ["pi", "--mode", "json", "-p", "--no-session", "--append-system-prompt", "<worker-prompt>"];
    if (this.model || input.model) args.push("--model", input.model || this.model);
    if (!this.allowWorkerDelegation && this.tools?.length) args.push("--tools", this.tools.join(","));
    args.push(`Task: ${input.task.slice(0, 60)}${input.task.length > 60 ? "..." : ""}`);
    return args.join(" ");
  }
}

class MockWorkerRunner {
  async runWorker(input) {
    const changedPaths = [];
    const changes = Array.isArray(input.mockChanges) && input.mockChanges.length > 0
      ? input.mockChanges
      : [{ path: path.join("orchestrator-mock", `${slugify(input.taskId)}.md`), content: `# ${input.taskId}\n\n${input.task}\n` }];

    for (const change of changes) {
      const rel = String(change.path).replace(/^@/, "");
      const target = path.resolve(input.cwd, rel);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, String(change.content ?? ""), "utf8");
      changedPaths.push(rel);
    }

    const commitResult = await addAndCommit(input.cwd, changedPaths, `orchestrator: mock complete ${input.taskId}`);
    return {
      status: "completed",
      exitCode: 0,
      summary: [`## Completed`, `Mock worker completed ${input.taskId}.`, "", "## Files Changed", ...changedPaths.map((p) => `- \`${p}\``), "", "## Validation", "- Mock validation succeeded.", "", "## Commit", `\`${commitResult.commit}\``, "", "## Notes", "None."].join("\n"),
      output: "",
      stderr: "",
      commit: commitResult.commit,
      changedFiles: changedPaths,
      usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    };
  }

  describeWorkerCommand(input) {
    return `mock-worker ${input.taskId}`;
  }
}

module.exports = { MockWorkerRunner, PiSubprocessWorkerRunner, buildWorkerPrompt };
