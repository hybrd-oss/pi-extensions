// cache-tax for pi: warn before a send that re-writes an expired prompt cache, and
// /keepwarm pings that replay the last request so the cache TTL keeps resetting.
// Covers providers that charge for cache writes: Bedrock Claude and Azure GPT-5.6.
// Idea from https://github.com/karanb192/cache-tax

const MIN = 60_000;
const GUARD_MIN_TOKENS = 50_000;
const PING_TEXT = "(cache keep-alive ping, not from the user) Reply with exactly: ok";
// Azure models that accept prompt_cache_retention: "24h" (gpt-5.5 is extended by default).
const AZURE_EXTENDED = /^gpt-(4\.1|5|5-codex|5\.1(-codex(-max|-mini)?|-chat)?|5\.2|5\.3-codex|5\.4)$/;

const longRetention = () => process.env.PI_CACHE_RETENTION === "long";

/** Cache behaviour for models where a cold send costs a write premium; undefined otherwise. */
export function cacheProfile(model) {
	if (!model?.cost) return undefined;
	if (model.api === "bedrock-converse-stream" && /claude/i.test(`${model.id} ${model.name}`)) {
		const long = longRetention();
		return {
			ttlMs: (long ? 60 : 5) * MIN,
			// pi's catalog only lists the 5m write rate; the 1h tier is 2x base input.
			writeRate: long ? model.cost.input * 2 : model.cost.cacheWrite,
			readRate: model.cost.cacheRead,
		};
	}
	if (model.api === "azure-openai-responses" && /gpt-5\.6/.test(model.id)) {
		return { ttlMs: 30 * MIN, writeRate: model.cost.cacheWrite, readRate: model.cost.cacheRead };
	}
	return undefined;
}

/** The last request with a ping message appended after the cached prefix. */
export function withPing(payload) {
	const next = structuredClone(payload);
	if (Array.isArray(next.input)) {
		// Responses API
		next.input.push({ type: "message", role: "user", content: [{ type: "input_text", text: PING_TEXT }] });
	} else {
		// Bedrock Converse: the last message is the user turn that carries pi's cachePoint.
		const last = next.messages.at(-1);
		if (last?.role === "user") last.content.push({ text: PING_TEXT });
		else next.messages.push({ role: "user", content: [{ text: PING_TEXT }] });
	}
	return next;
}

/** "90m", "2h", "1h30m" -> ms */
export function parseDuration(text) {
	const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text.trim());
	if (!m || (!m[1] && !m[2])) return undefined;
	return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * MIN;
}

const usd = (tokens, ratePerM) => `$${((tokens * ratePerM) / 1e6).toFixed(2)}`;
const mins = (ms) => (ms >= 60 * MIN ? `${Math.floor(ms / 60 / MIN)}h${Math.round((ms % (60 * MIN)) / MIN)}m` : `${Math.round(ms / MIN)}m`);

export default function (pi) {
	let lastPayload; // last main-agent request for the current cache profile
	let lastAt = 0; // when the cache was last written or read
	let keep; // { until, timer }

	function stop(ctx, reason) {
		if (!keep) return;
		clearTimeout(keep.timer);
		keep = undefined;
		ctx.ui.setStatus("cache-tax", undefined);
		if (reason) ctx.ui.notify(`keepwarm stopped: ${reason}`, "info");
	}

	function schedule(ctx, delay) {
		const profile = cacheProfile(ctx.model);
		if (!keep || !profile) return stop(ctx, "model has no write-priced cache");
		clearTimeout(keep.timer);
		keep.timer = setTimeout(() => ping(ctx), delay ?? Math.max(1_000, lastAt + profile.ttlMs * 0.8 - Date.now()));
	}

	async function ping(ctx) {
		if (!keep) return;
		const profile = cacheProfile(ctx.model);
		if (Date.now() > keep.until) return stop(ctx, "window ended");
		if (!profile || !lastPayload) return stop(ctx, "no request to replay yet");
		if (Date.now() - lastAt >= profile.ttlMs) return stop(ctx, "cache already cold");
		// Agent is mid-run (its own requests keep the cache warm) or real traffic moved the clock.
		if (!ctx.isIdle()) return schedule(ctx, 30_000);
		if (Date.now() - lastAt < profile.ttlMs * 0.8 - 1_000) return schedule(ctx);

		const payload = withPing(lastPayload);
		let r;
		try {
			r = await ctx.modelRegistry.complete(ctx.model, { messages: [] }, {
				sessionId: ctx.sessionManager.getSessionId(),
				onPayload: () => payload,
			});
		} catch (err) {
			return stop(ctx, `ping failed: ${err?.message ?? err}`);
		}
		if (!keep) return;
		if (r.stopReason === "error") return stop(ctx, `ping failed: ${r.errorMessage ?? "error"}`);
		const { cacheRead, cacheWrite, cost } = r.usage;
		if (!cacheRead || cacheWrite >= cacheRead * 0.1) {
			return stop(ctx, `ping read ${cacheRead} and wrote ${cacheWrite} tokens ($${cost.total.toFixed(2)}); cache was gone`);
		}
		lastAt = Date.now();
		ctx.ui.setStatus(
			"cache-tax",
			ctx.ui.theme.fg("dim", `keepwarm ${mins(keep.until - Date.now())} left · last ping read ${Math.round(cacheRead / 1000)}k $${cost.total.toFixed(3)}`),
		);
		schedule(ctx);
	}

	pi.on("session_start", (_event, ctx) => {
		// Seed the clock from the last assistant reply so the first send after resume is guarded.
		const last = ctx.sessionManager
			.getBranch()
			.findLast((e) => e.type === "message" && e.message?.role === "assistant");
		lastAt = last?.message?.timestamp ?? 0;
		lastPayload = undefined;
	});

	pi.on("session_shutdown", (_event, ctx) => stop(ctx));

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (
			longRetention() &&
			model?.api === "azure-openai-responses" &&
			AZURE_EXTENDED.test(model.id) &&
			event.payload?.prompt_cache_retention === undefined
		) {
			// pi's Azure provider never forwards cache retention; same price, cached up to 24h.
			return { ...event.payload, prompt_cache_retention: "24h" };
		}
		if (cacheProfile(model)) {
			lastPayload = structuredClone(event.payload);
			lastAt = Date.now();
		}
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension" || event.text.trimStart().startsWith("/")) return;
		const profile = cacheProfile(ctx.model);
		const idle = Date.now() - lastAt;
		if (!profile || !lastAt || idle < profile.ttlMs) return;
		const tokens = ctx.getContextUsage()?.tokens ?? 0;
		if (tokens < GUARD_MIN_TOKENS) return;

		const msg =
			`Prompt cache went cold ${mins(idle)} ago. Sending re-writes up to ${tokens.toLocaleString()} tokens ` +
			`≈ ${usd(tokens, profile.writeRate)} (warm would be ${usd(tokens, profile.readRate)}).`;
		if (!ctx.hasUI) return void ctx.ui.notify(`cache-tax: ${msg}`, "warning");
		if (await ctx.ui.confirm("cache-tax", `${msg}\n\nSend anyway? (or /clear and start fresh)`)) return;
		ctx.ui.setEditorText(event.text);
		return { action: "handled" };
	});

	pi.registerCommand("keepwarm", {
		description: "Keep the prompt cache warm: /keepwarm [90m|2h|off]",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();
			if (arg === "off") return stop(ctx, "turned off");
			const profile = cacheProfile(ctx.model);
			if (!profile) {
				return ctx.ui.notify(
					"keepwarm: this model has no cache-write charge (or isn't Bedrock Claude / Azure GPT-5.6); nothing to keep warm.",
					"info",
				);
			}
			const window = arg ? parseDuration(arg) : 60 * MIN;
			if (!window) return ctx.ui.notify("keepwarm: use e.g. /keepwarm 90m, /keepwarm 2h, /keepwarm off", "error");
			if (!lastPayload) return ctx.ui.notify("keepwarm: send one message first so there is a request to replay.", "error");
			if (Date.now() - lastAt >= profile.ttlMs) return ctx.ui.notify("keepwarm: cache is already cold.", "warning");

			stop(ctx);
			keep = { until: Date.now() + window };
			const every = profile.ttlMs * 0.8;
			const tokens = ctx.getContextUsage()?.tokens ?? 0;
			const pings = Math.ceil(window / every);
			ctx.ui.notify(
				`keepwarm ${mins(window)}: ~${pings} pings every ${mins(every)}, each ≈ ${usd(tokens, profile.readRate)} + output; ` +
					`a cold rewrite ≈ ${usd(tokens, profile.writeRate)}.`,
				"info",
			);
			ctx.ui.setStatus("cache-tax", ctx.ui.theme.fg("dim", `keepwarm ${mins(window)} · ping in ${mins(lastAt + every - Date.now())}`));
			schedule(ctx);
		},
	});
}
