/**
 * Destructive Command Guard (DCG) Extension for Pi
 *
 * Intercepts bash tool calls and pipes them through DCG to detect
 * destructive commands. On block, presents the user with options
 * to block, allow once, or permanently allowlist the rule.
 *
 * Requires `dcg` to be installed: https://github.com/Dicklesworthstone/destructive_command_guard
 *
 * The actual `dcg` protocol (spawning it, parsing its JSON) lives in `./lib/dcg-protocol.mjs`,
 * which has zero pi-specific imports and is unit-tested directly (see `test/`). This file is
 * only the pi hook wiring on top of that.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { dcgAllowOnce, dcgAllowlistAdd, runDcg } from "./lib/dcg-protocol.mjs";

export default function (pi: ExtensionAPI) {
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
        await dcgAllowOnce(allowOnceCode);
        ctx.ui.notify(`DCG: Allowed once (code ${allowOnceCode})`, "info");
        return undefined;
      } catch (err: any) {
        ctx.ui.notify(`DCG: Failed to run allow-once: ${err.message}`, "error");
        return { block: true, reason: "DCG allow-once failed" };
      }
    }

    if (choice?.startsWith("📋") && ruleId) {
      try {
        await dcgAllowlistAdd(ruleId, "Allowed via pi DCG extension");
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
