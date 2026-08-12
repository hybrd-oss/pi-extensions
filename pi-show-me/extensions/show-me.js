import { readFileSync } from "node:fs";

const MODE_ENTRY = "show-me-mode";
const SKILL_BODY = readFileSync(new URL("../skills/show-me/SKILL.md", import.meta.url), "utf8")
  .replace(/^---\s*[\s\S]*?---\s*/, "")
  .trim();

export function restoreShowMeMode(entries, fallback = true) {
  if (!Array.isArray(entries)) return fallback;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "custom" && entry.customType === MODE_ENTRY && typeof entry.data?.active === "boolean") {
      return entry.data.active;
    }
  }

  return fallback;
}

export default function showMeExtension(pi) {
  let active = true;

  function syncStatus(ctx) {
    ctx?.ui?.setStatus?.("show-me", active ? "[SHOW-ME]" : undefined);
  }

  function setActive(next, ctx) {
    active = next;
    pi.appendEntry(MODE_ENTRY, { active });
    syncStatus(ctx);
    ctx?.ui?.notify?.(`Show Me ${active ? "on" : "off"}.`, "info");
  }

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx?.sessionManager?.getBranch?.() ?? ctx?.sessionManager?.getEntries?.() ?? [];
    active = restoreShowMeMode(entries);
    syncStatus(ctx);
  });

  pi.on("before_agent_start", async (event) => {
    if (!active) return;
    const base = event?.systemPrompt ? `${event.systemPrompt}\n\n` : "";
    return {
      systemPrompt: `${base}SHOW-ME MODE ACTIVE\n\n${SKILL_BODY}`,
    };
  });

  pi.registerCommand("show-me", {
    description: "Show Me mode: /show-me [on|off|status]",
    handler: async (args, ctx) => {
      const command = String(args ?? "").trim().toLowerCase();

      if (!command || command === "on") {
        setActive(true, ctx);
        return;
      }
      if (command === "off") {
        setActive(false, ctx);
        return;
      }
      if (command === "status") {
        syncStatus(ctx);
        ctx?.ui?.notify?.(`Show Me: ${active ? "on" : "off"}.`, "info");
        return;
      }

      ctx?.ui?.notify?.("Usage: /show-me [on|off|status]", "warning");
    },
  });
}
