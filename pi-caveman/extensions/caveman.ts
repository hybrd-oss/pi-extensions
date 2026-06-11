import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

type Mode = "lite" | "full" | "ultra" | "wenyan-lite" | "wenyan-full" | "wenyan-ultra";

const CUSTOM_TYPE = "caveman-mode";
const SAVINGS_RATE = 0.65;
const INHERIT_BLOCK_RE =
	/<!--\s*pi-caveman-inherit\s+mode=(wenyan-ultra|wenyan-full|wenyan-lite|ultra|full|lite)\s*-->[\s\S]*?<!--\s*\/pi-caveman-inherit\s*-->\n*/i;

const MODE_ALIASES: Record<string, Mode> = {
	lite: "lite",
	full: "full",
	ultra: "ultra",
	wenyan: "wenyan-full",
	"wenyan-lite": "wenyan-lite",
	"wenyan-full": "wenyan-full",
	"wenyan-ultra": "wenyan-ultra",
};

function normalizeMode(value: string | undefined): Mode | undefined {
	if (!value) return undefined;
	return MODE_ALIASES[value.trim().toLowerCase()];
}

function configuredDefaultMode(): Mode {
	const envMode = normalizeMode(process.env.CAVEMAN_DEFAULT_MODE);
	if (envMode) return envMode;

	const configPath = join(homedir(), ".config", "caveman", "config.json");
	if (existsSync(configPath)) {
		try {
			const parsed = JSON.parse(readFileSync(configPath, "utf8"));
			const fileMode = normalizeMode(parsed?.defaultMode);
			if (fileMode) return fileMode;
		} catch {
			// Ignore broken optional config. /caveman still works.
		}
	}

	return "full";
}

function modeInstruction(mode: Mode): string {
	const base = "CAVEMAN MODE ACTIVE. Keep full technical accuracy. Drop pleasantries, filler, hedging. Code, paths, commands, API names, and quoted errors stay exact.";
	switch (mode) {
		case "lite":
			return `${base} Style: tight professional prose; keep grammar/articles when useful.`;
		case "full":
			return `${base} Style: smart caveman fragments; drop articles where safe; short words.`;
		case "ultra":
			return `${base} Style: ultra terse; abbreviate prose only; use arrows/tables; no ambiguity.`;
		case "wenyan-lite":
			return `${base} Style: semi-classical Chinese, light compression.`;
		case "wenyan-full":
			return `${base} Style: 文言文 terse. Classical particles OK. Preserve technical tokens exact.`;
		case "wenyan-ultra":
			return `${base} Style: extreme 文言 compression. Preserve technical tokens exact.`;
	}
}

function inheritedStyleInstruction(mode: Mode): string {
	const base = "Inherited response style from parent. Keep full technical accuracy. Drop pleasantries, filler, hedging. Code, paths, commands, API names, and quoted errors stay exact.";
	switch (mode) {
		case "lite":
			return `${base} Style: tight professional prose; keep grammar/articles when useful.`;
		case "full":
			return `${base} Style: smart terse fragments; drop articles where safe; short words.`;
		case "ultra":
			return `${base} Style: ultra terse; abbreviate prose only; use arrows/tables; no ambiguity.`;
		case "wenyan-lite":
			return `${base} Style: semi-classical Chinese, light compression.`;
		case "wenyan-full":
			return `${base} Style: 文言文 terse. Classical particles OK. Preserve technical tokens exact.`;
		case "wenyan-ultra":
			return `${base} Style: extreme 文言 compression. Preserve technical tokens exact.`;
	}
}

function subagentInheritanceBlock(mode: Mode): string {
	return `<!-- pi-caveman-inherit mode=${mode} -->\n${inheritedStyleInstruction(mode)}\n<!-- /pi-caveman-inherit -->`;
}

function parseInheritedInput(text: string): { mode: Mode; text: string } | undefined {
	const match = text.match(INHERIT_BLOCK_RE);
	const inheritedMode = normalizeMode(match?.[1]);
	if (!inheritedMode) return undefined;
	return { mode: inheritedMode, text: text.replace(INHERIT_BLOCK_RE, "").trimStart() };
}

function isOffRequest(text: string): boolean {
	const normalized = text.trim().toLowerCase();
	return [
		"normal mode",
		"stop caveman",
		"caveman off",
		"/caveman off",
		"/caveman normal",
		"/skill:caveman off",
		"/skill:caveman normal",
	].includes(normalized);
}

function isBareActivation(text: string): boolean {
	const normalized = text.trim().toLowerCase();
	return [
		"caveman",
		"caveman mode",
		"talk like caveman",
		"use caveman",
	].includes(normalized);
}

function isActivationRequest(text: string): boolean {
	const normalized = text.toLowerCase();
	return /\b(caveman mode|talk like caveman|use caveman)\b/.test(normalized);
}

function firstToken(text: string): string | undefined {
	return text.trim().split(/\s+/)[0];
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

export default function (pi: ExtensionAPI) {
	let active = false;
	let mode: Mode = configuredDefaultMode();

	function setStatus(ctx: any) {
		if (!ctx?.ui?.setStatus) return;
		ctx.ui.setStatus("caveman", active ? `[CAVEMAN ${mode}]` : "");
	}

	function persist(ctx: any) {
		pi.appendEntry(CUSTOM_TYPE, { active, mode, timestamp: Date.now() });
		setStatus(ctx);
	}

	function restore(ctx: any) {
		for (const entry of ctx.sessionManager.getEntries() as any[]) {
			if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
			active = Boolean(entry.data?.active);
			mode = normalizeMode(entry.data?.mode) ?? mode;
		}
		setStatus(ctx);
	}

	function activate(ctx: any, requestedMode?: Mode) {
		active = true;
		mode = requestedMode ?? mode ?? configuredDefaultMode();
		persist(ctx);
	}

	function deactivate(ctx: any) {
		active = false;
		persist(ctx);
	}

	function sendSkill(name: string, args: string, ctx: any) {
		const message = args.trim() ? `/skill:${name} ${args.trim()}` : `/skill:${name}`;
		if (ctx.isIdle?.()) pi.sendUserMessage(message);
		else pi.sendUserMessage(message, { deliverAs: "steer" });
	}

	function wrapSubagentTask(task: string): string {
		if (INHERIT_BLOCK_RE.test(task)) return task;
		return `${subagentInheritanceBlock(mode)}\n\n${task}`;
	}

	pi.on("session_start", async (_event, ctx) => {
		restore(ctx);
	});

	pi.on("input", async (event, ctx) => {
		const text = event.text ?? "";
		const trimmed = text.trim();
		const lower = trimmed.toLowerCase();
		const inherited = parseInheritedInput(text);

		if (inherited) {
			activate(ctx, inherited.mode);
			return {
				action: "transform" as const,
				text: `${modeInstruction(mode)}\n\nUser request:\n${inherited.text}`,
				images: event.images,
			};
		}

		if (isOffRequest(trimmed)) {
			deactivate(ctx);
			ctx.ui.notify("Caveman off. Normal mode.", "info");
			return { action: "handled" as const };
		}

		if (/^\/skill:caveman(?:\s|$)/.test(lower)) {
			const token = firstToken(trimmed.slice("/skill:caveman".length));
			const requestedMode = normalizeMode(token);
			activate(ctx, requestedMode);
			return { action: "continue" as const };
		}

		if (isBareActivation(trimmed)) {
			activate(ctx);
			ctx.ui.notify(`Caveman on (${mode}).`, "info");
			return { action: "handled" as const };
		}

		if (isActivationRequest(trimmed)) {
			activate(ctx, normalizeMode(firstToken(trimmed)));
		}

		// Let slash commands and skill expansion pass through untouched.
		if (!active || trimmed.startsWith("/")) return { action: "continue" as const };

		return {
			action: "transform" as const,
			text: `${modeInstruction(mode)}\n\nUser request:\n${text}`,
			images: event.images,
		};
	});

	pi.on("tool_call", async (event) => {
		if (!active || event.toolName !== "subagent") return;

		const input = event.input as any;
		if (typeof input.task === "string") input.task = wrapSubagentTask(input.task);

		if (Array.isArray(input.tasks)) {
			for (const item of input.tasks) {
				if (typeof item?.task === "string") item.task = wrapSubagentTask(item.task);
			}
		}

		if (Array.isArray(input.chain)) {
			for (const item of input.chain) {
				if (typeof item?.task === "string") item.task = wrapSubagentTask(item.task);
			}
		}
	});

	pi.registerCommand("caveman", {
		description: "Toggle caveman mode: /caveman [lite|full|ultra|wenyan-*|off] [message]",
		getArgumentCompletions: (prefix: string) => {
			return Object.keys(MODE_ALIASES)
				.concat(["off", "normal"])
				.filter((value) => value.startsWith(prefix.toLowerCase()))
				.map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const head = parts[0]?.toLowerCase();

			if (head === "off" || head === "normal" || head === "stop") {
				deactivate(ctx);
				ctx.ui.notify("Caveman off. Normal mode.", "info");
				return;
			}

			let rest = args.trim();
			const requestedMode = normalizeMode(head);
			if (requestedMode) {
				mode = requestedMode;
				rest = parts.slice(1).join(" ");
			}

			activate(ctx, mode);
			ctx.ui.notify(`Caveman on (${mode}).`, "info");

			if (rest) {
				if (ctx.isIdle?.()) pi.sendUserMessage(rest);
				else pi.sendUserMessage(rest, { deliverAs: "steer" });
			}
		},
	});

	pi.registerCommand("caveman-help", {
		description: "Show caveman command help",
		handler: async (args, ctx) => sendSkill("caveman-help", args, ctx),
	});

	pi.registerCommand("caveman-commit", {
		description: "Generate terse Conventional Commit message",
		handler: async (args, ctx) => sendSkill("caveman-commit", args, ctx),
	});

	pi.registerCommand("caveman-review", {
		description: "Generate terse code review comments",
		handler: async (args, ctx) => sendSkill("caveman-review", args, ctx),
	});

	pi.registerCommand("caveman-compress", {
		description: "Compress natural language file into caveman prose",
		handler: async (args, ctx) => sendSkill("caveman-compress", args, ctx),
	});

	pi.registerCommand("caveman-stats", {
		description: "Show Pi session token usage while caveman mode was active",
		handler: async (_args, ctx) => {
			let enabled = false;
			let output = 0;
			let input = 0;

			for (const entry of ctx.sessionManager.getEntries() as any[]) {
				if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
					enabled = Boolean(entry.data?.active);
					continue;
				}

				if (!enabled || entry.type !== "message") continue;
				const msg = entry.message;
				if (msg?.role !== "assistant" || !msg.usage) continue;
				output += msg.usage.output ?? 0;
				input += msg.usage.input ?? 0;
			}

			const saved = Math.round(output * (SAVINGS_RATE / (1 - SAVINGS_RATE)));
			ctx.ui.notify(
				`Caveman stats: ${formatTokens(output)} output tokens in mode; est saved ${formatTokens(saved)}. Input seen: ${formatTokens(input)}.`,
				"info",
			);
		},
	});
}
