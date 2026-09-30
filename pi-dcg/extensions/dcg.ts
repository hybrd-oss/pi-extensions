/**
 * Destructive Command Guard (DCG) Extension for Pi
 *
 * Intercepts bash tool calls and pipes them through DCG to detect
 * destructive commands. Blocks denied commands by default; prompt mode can
 * instead offer block, allow-once, and allowlist options.
 *
 * Requires `dcg` to be installed: https://github.com/Dicklesworthstone/destructive_command_guard
 *
 * The actual `dcg` protocol (spawning it, parsing its JSON) lives in `./lib/dcg-protocol.mjs`,
 * which has zero pi-specific imports and is unit-tested directly (see `test/`). This file is
 * only the pi hook wiring on top of that.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dcgAllowOnce, dcgAllowlistAdd, formatDcgBlockReason, runDcg } from "./lib/dcg-protocol.mjs";

type Mode = "block" | "prompt";

function configuredMode(): Mode {
  const value = process.env.PI_DCG_MODE;
  if (value === "block" || value === "prompt") return value;

  const configPath = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "pi-dcg", "config.json");
  try {
    const mode = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8"))?.mode : undefined;
    if (mode === "block" || mode === "prompt") return mode;
  } catch {
    // Ignore a broken optional config; secure default remains block.
  }
  return "block";
}

export default function (pi: ExtensionAPI) {
  const mode = configuredMode();
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return undefined;

    const command = event.input.command;
    if (!command) return undefined;

    let result: Awaited<ReturnType<typeof runDcg>>;
    try {
      result = await runDcg(command);
    } catch (err: any) {
      ctx.ui.notify(err.message, "error");
      return { block: true, reason: err.message };
    }

    if (result.decision === "allow") return undefined;

    // --- Blocked by DCG ---
    const { reason, allowOnceCode, ruleId } = result;
    const blockReason = formatDcgBlockReason(result);

    // Default to a pre-tool-hook-style denial; prompt mode is explicit opt-in.
    if (mode === "block" || !ctx.hasUI) return { block: true, reason: blockReason };

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
        await dcgAllowOnce(allowOnceCode);
        ctx.ui.notify(`DCG: Allowed once (code ${allowOnceCode})`, "info");
        return undefined;
      } catch (err: any) {
        ctx.ui.notify(`DCG: Failed to run allow-once: ${err.message}`, "error");
        return { block: true, reason: `${blockReason}\n\nDCG allow-once failed: ${err.message}` };
      }
    }

    if (choice?.startsWith("📋") && ruleId) {
      try {
        await dcgAllowlistAdd(ruleId, "Allowed via pi DCG extension");
        ctx.ui.notify(`DCG: Rule ${ruleId} added to allowlist`, "info");
        return undefined;
      } catch (err: any) {
        ctx.ui.notify(`DCG: Failed to add to allowlist: ${err.message}`, "error");
        return { block: true, reason: `${blockReason}\n\nDCG allowlist add failed: ${err.message}` };
      }
    }

    return { block: true, reason: blockReason };
  });
}
