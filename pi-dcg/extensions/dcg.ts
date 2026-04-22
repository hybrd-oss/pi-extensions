/**
 * Destructive Command Guard (DCG) Extension for Pi
 *
 * Intercepts bash tool calls and pipes them through DCG to detect
 * destructive commands. On block, presents the user with options
 * to block, allow once, or permanently allowlist the rule.
 *
 * Requires `dcg` to be installed: https://github.com/Dicklesworthstone/destructive_command_guard
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface DcgResult {
  decision: "allow" | "deny";
  reason?: string;
  allowOnceCode?: string;
  ruleId?: string;
}

function spawnWithStdin(cmd: string, args: string[], input: string, timeout: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
    }, timeout);

    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    proc.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(Object.assign(new Error("Process timed out"), { code: "ETIMEDOUT" }));
      } else {
        resolve({ stdout, stderr });
      }
    });

    proc.stdin.write(input);
    proc.stdin.end();
  });
}

async function runDcg(command: string): Promise<DcgResult> {
  const input = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command },
  });

  try {
    const { stdout, stderr } = await spawnWithStdin("dcg", [], input, 10_000);

    // Safe commands produce no output
    const trimmed = stdout.trim();
    if (!trimmed) return { decision: "allow" };

    // Parse JSON from stdout
    const jsonMatch = trimmed.match(/\{[^{}]*"hookSpecificOutput"[^}]*\{[^}]*\}[^}]*\}/);
    if (!jsonMatch) return { decision: "allow" };

    const parsed = JSON.parse(jsonMatch[0]);
    const hook = parsed?.hookSpecificOutput;
    if (!hook || hook.permissionDecision !== "deny") return { decision: "allow" };

    // Extract rule ID from stderr (rich output has "Rule: <id>")
    const ruleMatch = stderr.match(/Rule:\s+(\S+)/);

    return {
      decision: "deny",
      reason: hook.permissionDecisionReason,
      allowOnceCode: hook.allowOnceCode,
      ruleId: ruleMatch?.[1],
    };
  } catch (err: any) {
    if (err.code === "ENOENT") {
      throw new Error("dcg not found on PATH. Install from: https://github.com/Dicklesworthstone/destructive_command_guard");
    }
    // Other errors (timeout, etc.) — fail open but notify
    return { decision: "allow" };
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return undefined;

    const command = event.input.command;
    if (!command) return undefined;

    let result: DcgResult;
    try {
      result = await runDcg(command);
    } catch (err: any) {
      ctx.ui.notify(err.message, "error");
      return { block: true, reason: err.message };
    }

    if (result.decision === "allow") return undefined;

    // --- Blocked by DCG ---
    const { reason, allowOnceCode, ruleId } = result;

    // Non-interactive mode: auto-block
    if (!ctx.hasUI) {
      return { block: true, reason: `DCG: ${reason ?? "Blocked"}` };
    }

    // Build options
    const options: string[] = ["❌ Block"];
    if (allowOnceCode) {
      options.push("✅ Allow Once");
    }
    if (ruleId) {
      options.push(`📋 Allowlist Rule (${ruleId})`);
    }

    // Build display text
    const reasonLines = (reason ?? "Blocked by DCG")
      .split("\n")
      .filter((l) => l.trim())
      .slice(0, 4);
    const displayReason = reasonLines.join("\n  ");
    let prompt = `🛡 DCG Blocked:\n\n  ${displayReason}\n\n  Command: ${command}`;
    if (ruleId) prompt += `\n  Rule: ${ruleId}`;
    prompt += "\n";

    const choice = await ctx.ui.select(prompt, options);

    if (choice?.startsWith("✅") && allowOnceCode) {
      try {
        await execFileAsync("dcg", ["allow-once", allowOnceCode], { timeout: 5_000 });
        ctx.ui.notify(`DCG: Allowed once (code ${allowOnceCode})`, "info");
        return undefined;
      } catch {
        ctx.ui.notify("DCG: Failed to run allow-once", "error");
        return { block: true, reason: "DCG allow-once failed" };
      }
    }

    if (choice?.startsWith("📋") && ruleId) {
      try {
        await execFileAsync("dcg", ["allowlist", "add", ruleId, "--reason", "Allowed via pi DCG extension"], {
          timeout: 5_000,
        });
        ctx.ui.notify(`DCG: Rule ${ruleId} added to allowlist`, "info");
        return undefined;
      } catch (err: any) {
        ctx.ui.notify(`DCG: Failed to add to allowlist: ${err.message}`, "error");
        return { block: true, reason: "DCG allowlist add failed" };
      }
    }

    return { block: true, reason: "Blocked by DCG" };
  });
}
