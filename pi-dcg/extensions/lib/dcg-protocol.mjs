/**
 * Pure DCG-CLI protocol logic: spawn `dcg`, parse its hook-protocol JSON output, decide.
 *
 * Deliberately has ZERO dependency on pi's extension API. That keeps this module loadable
 * (and testable) with plain Node, without pi's jiti-based extension loader or a live LLM turn.
 * `dcg.ts` imports this and adds only the pi-specific hook wiring on top.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function spawnWithStdin(cmd, args, input, timeout) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
    }, timeout);

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(Object.assign(new Error("Process timed out"), { code: "ETIMEDOUT" }));
      } else {
        resolve({ stdout, stderr, exitCode: code });
      }
    });

    proc.stdin.write(input);
    proc.stdin.end();
  });
}

/**
 * Extract the first balanced top-level `{...}` object from `text` that contains `mustInclude`.
 *
 * dcg's hook-protocol output nests objects arbitrarily deep (a `remediation` sub-object is
 * common, and it can itself contain further nested fields). A single-level regex like
 * `\{[^}]*\{[^}]*\}[^}]*\}` cannot express arbitrary nesting: it stops at the first inner `}`
 * regardless of depth, so it matches a truncated, unbalanced substring for anything nested more
 * than one level deep. `JSON.parse` on that substring throws, and a naive caller can end up
 * treating the parse failure as "no decision" and failing open — silently allowing a command
 * dcg actually denied. Real brace counting handles any nesting depth correctly.
 */
export function extractBalancedJsonObject(text, mustInclude) {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          if (candidate.includes(mustInclude)) return candidate;
          break;
        }
      }
    }
  }
  return undefined;
}

/** Parse dcg's raw stdout into a decision. Pure — no subprocess, no I/O. */
export function decideFromDcgStdout(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return { decision: "allow" };

  // dcg's hook-protocol stdout is pure JSON; parse it directly first. Fall back to a
  // balanced-brace scan only if something (a banner line, etc.) surrounds the JSON.
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const jsonText = extractBalancedJsonObject(trimmed, "hookSpecificOutput");
    if (!jsonText) return { decision: "allow" };
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return { decision: "allow" };
    }
  }

  const hook = parsed?.hookSpecificOutput;
  if (!hook || hook.permissionDecision !== "deny") return { decision: "allow" };

  return {
    decision: "deny",
    reason: hook.permissionDecisionReason,
    allowOnceCode: hook.allowOnceCode,
    ruleId: hook.ruleId,
  };
}

/** Spawn `dcg`, feed it the hook-protocol request for `command`, and decide. */
export async function runDcg(command) {
  const input = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command },
  });

  try {
    const { stdout } = await spawnWithStdin("dcg", [], input, 10_000);
    return decideFromDcgStdout(stdout);
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error("dcg not found on PATH. Install from: https://github.com/Dicklesworthstone/destructive_command_guard");
    }
    // Other errors (timeout, etc.) — fail open but the caller should surface `err` to the user.
    return { decision: "allow" };
  }
}

export async function dcgAllowOnce(code) {
  const { stdout, stderr, exitCode } = await spawnWithStdin("dcg", ["allow-once", code], "y\n", 5_000);
  if (exitCode !== 0) {
    throw new Error((stderr || stdout || `dcg allow-once exited with code ${exitCode}`).trim());
  }
}

export async function dcgAllowlistAdd(ruleId, reason) {
  await execFileAsync("dcg", ["allowlist", "add", ruleId, "--reason", reason], { timeout: 5_000 });
}
