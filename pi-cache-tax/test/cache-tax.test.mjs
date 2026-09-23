import assert from "node:assert/strict";
import test from "node:test";

import cacheTax, { cacheProfile, parseDuration, withPing } from "../extensions/cache-tax.js";

const bedrock = { api: "bedrock-converse-stream", id: "global.anthropic.claude-opus-4-8", name: "Claude Opus 4.8", cost: { input: 5, cacheRead: 0.5, cacheWrite: 6.25 } };
const azure56 = { api: "azure-openai-responses", id: "gpt-5.6-sol", cost: { input: 4, cacheRead: 0.4, cacheWrite: 5 } };
const azure54 = { api: "azure-openai-responses", id: "gpt-5.4", cost: { input: 2.5, cacheRead: 0.25, cacheWrite: 0 } };
const xai = { api: "openai-responses", id: "grok-4.3", cost: { input: 1.25, cacheRead: 0.2, cacheWrite: 0 } };

test("profiles only write-priced caches", () => {
	delete process.env.PI_CACHE_RETENTION;
	assert.equal(cacheProfile(bedrock).ttlMs, 5 * 60_000);
	assert.equal(cacheProfile(bedrock).writeRate, 6.25);
	process.env.PI_CACHE_RETENTION = "long";
	assert.equal(cacheProfile(bedrock).ttlMs, 60 * 60_000);
	assert.equal(cacheProfile(bedrock).writeRate, 10);
	delete process.env.PI_CACHE_RETENTION;
	assert.equal(cacheProfile(azure56).ttlMs, 30 * 60_000);
	assert.equal(cacheProfile(azure54), undefined);
	assert.equal(cacheProfile(xai), undefined);
});

test("ping is appended after the cached prefix without mutating the original", () => {
	const converse = { messages: [{ role: "user", content: [{ text: "hi" }, { cachePoint: { type: "default" } }] }] };
	const pinged = withPing(converse);
	assert.equal(converse.messages[0].content.length, 2);
	assert.deepEqual(pinged.messages[0].content.slice(0, 2), converse.messages[0].content);
	assert.match(pinged.messages[0].content[2].text, /ping/);

	const responses = { input: [{ type: "function_call_output", call_id: "c", output: "x" }] };
	const pingedR = withPing(responses);
	assert.equal(pingedR.input.length, 2);
	assert.equal(pingedR.input[1].content[0].type, "input_text");
});

test("parseDuration", () => {
	assert.equal(parseDuration("90m"), 90 * 60_000);
	assert.equal(parseDuration("1h30m"), 90 * 60_000);
	assert.equal(parseDuration("soon"), undefined);
	assert.equal(parseDuration(""), undefined);
});

function harness(model) {
	const on = new Map();
	const commands = new Map();
	const ui = { notes: [], editor: undefined, confirmAnswer: false };
	cacheTax({ on: (n, h) => on.set(n, h), registerCommand: (n, o) => commands.set(n, o) });
	const ctx = {
		model,
		hasUI: true,
		getContextUsage: () => ({ tokens: 200_000 }),
		sessionManager: { getBranch: () => [], getSessionId: () => "s" },
		ui: {
			notify: (m) => ui.notes.push(m),
			confirm: async () => ui.confirmAnswer,
			setEditorText: (t) => (ui.editor = t),
			setStatus: () => {},
			theme: { fg: (_c, t) => t },
		},
	};
	return { on, commands, ctx, ui };
}

test("guard asks before a cold send and restores the text when declined", async (t) => {
	const { on, ctx, ui } = harness(bedrock);
	t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
	on.get("before_provider_request")({ payload: { messages: [] } }, ctx);

	const input = { text: "recap please", source: "interactive" };
	assert.equal(await on.get("input")(input, ctx), undefined, "warm: passes through");

	t.mock.timers.tick(6 * 60_000);
	assert.deepEqual(await on.get("input")({ text: "/model", source: "interactive" }, ctx), undefined, "slash commands pass");
	assert.deepEqual(await on.get("input")(input, ctx), { action: "handled" });
	assert.equal(ui.editor, "recap please");

	ui.confirmAnswer = true;
	assert.equal(await on.get("input")(input, ctx), undefined, "confirmed: sends");
});

test("azure 24h retention added only for extended-capable models under long retention", (t) => {
	process.env.PI_CACHE_RETENTION = "long";
	t.after(() => delete process.env.PI_CACHE_RETENTION);
	const a = harness(azure54);
	assert.equal(a.on.get("before_provider_request")({ payload: { input: [] } }, a.ctx).prompt_cache_retention, "24h");
	const b = harness(azure56);
	assert.equal(b.on.get("before_provider_request")({ payload: { input: [] } }, b.ctx), undefined);
});
