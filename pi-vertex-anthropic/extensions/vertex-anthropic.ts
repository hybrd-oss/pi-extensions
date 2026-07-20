/**
 * Claude on Google Cloud Vertex AI, via Application Default Credentials (ADC).
 *
 * Goal: use GCP credits for Claude without an Anthropic API key. Auth is
 * ambient — google-auth-library (inside `@anthropic-ai/vertex-sdk`) picks up
 * whatever ADC source exists: `gcloud auth application-default login`, a
 * `GOOGLE_APPLICATION_CREDENTIALS` service-account file, or GCE/GKE metadata.
 * There is no pi `/login` flow — set up ADC once in your shell and select a
 * `vertex-anthropic` model.
 *
 * Streaming injects the `AnthropicVertex` client into pi-ai's built-in
 * Anthropic `stream()` (the documented `AnthropicOptions.client` hook), so
 * message conversion, SSE parsing, tool calls, caching, and thinking all come
 * from pi. Model metadata (cost, context, thinking config) is read live from
 * pi's own Anthropic registry via `getModel`, so it stays in sync.
 *
 * Only the compat surface of `@earendil-works/pi-ai` is imported — pi remaps
 * that package to its bundled `compat.js` for extensions, so deep subpath
 * imports (`/api/*`, `/providers/*`) do not resolve and must not be used.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import type Anthropic from "@anthropic-ai/sdk";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getModel, streamAnthropic } from "@earendil-works/pi-ai";
import type { Api, Context, Model, SimpleStreamOptions, ThinkingLevel } from "@earendil-works/pi-ai";

// AnthropicEffort is not exported from the compat surface; inline the union.
type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

const PROVIDER = "vertex-anthropic";
const DEFAULT_REGION = "global";
const REGION_RE = /^[a-z0-9-]+$/;

// =============================================================================
// Project / region resolution: env override -> ADC file. Region defaults to
// "global" (multi-region routing). Set GOOGLE_CLOUD_LOCATION to pin a region.
// =============================================================================

function adcCredentialsPath(): string | undefined {
	const explicit = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
	if (explicit) return existsSync(explicit) ? explicit : undefined;
	const defaultPath =
		platform() === "win32"
			? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "gcloud", "application_default_credentials.json")
			: join(homedir(), ".config", "gcloud", "application_default_credentials.json");
	return existsSync(defaultPath) ? defaultPath : undefined;
}

function projectFromAdcFile(): string | undefined {
	const path = adcCredentialsPath();
	if (!path) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { project_id?: unknown; quota_project_id?: unknown };
		const project = parsed.project_id ?? parsed.quota_project_id;
		return typeof project === "string" && project.trim() ? project.trim() : undefined;
	} catch {
		return undefined;
	}
}

function resolveProjectId(): string {
	const project =
		process.env.ANTHROPIC_VERTEX_PROJECT_ID?.trim() ||
		process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
		process.env.GCLOUD_PROJECT?.trim() ||
		projectFromAdcFile();
	if (!project) {
		throw new Error(
			"vertex-anthropic: no GCP project resolvable. Run `gcloud auth application-default login` " +
				"(and optionally `gcloud auth application-default set-quota-project <project>`), or set " +
				"ANTHROPIC_VERTEX_PROJECT_ID / GOOGLE_CLOUD_PROJECT.",
		);
	}
	return project;
}

function resolveRegion(): string {
	const region = process.env.GOOGLE_CLOUD_LOCATION?.trim() || process.env.CLOUD_ML_REGION?.trim();
	return region && REGION_RE.test(region) ? region : DEFAULT_REGION;
}

// AnthropicVertex client, cached by project+region.
const clientCache = new Map<string, AnthropicVertex>();

function getVertexClient(): AnthropicVertex {
	const projectId = resolveProjectId();
	const region = resolveRegion();
	const key = `${projectId}|${region}`;
	let client = clientCache.get(key);
	if (!client) {
		client = new AnthropicVertex({ projectId, region });
		clientCache.set(key, client);
	}
	return client;
}

// =============================================================================
// streamSimple: pi-ai's own anthropic streamSimple logic, but calling
// streamAnthropic with the injected Vertex client. (pi-ai's streamSimple builds
// its own api.anthropic.com client and drops `client`, so it can't be reused.)
// =============================================================================

function mapEffort(model: Model<Api>, level: ThinkingLevel): AnthropicEffort {
	const mapped = model.thinkingLevelMap?.[level];
	if (typeof mapped === "string") return mapped as AnthropicEffort;
	if (level === "minimal" || level === "low") return "low";
	if (level === "medium") return "medium";
	return "high";
}

// Budget-based thinking for non-adaptive models (e.g. Haiku). Mirrors pi-ai's
// adjustMaxTokensForThinking defaults.
const THINKING_BUDGETS: Record<string, number> = { minimal: 1024, low: 2048, medium: 8192, high: 16384 };

function streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
	// AnthropicVertex is the same messaging shape as pi-ai's bundled Anthropic
	// SDK; a separate module instance makes TS treat them as distinct classes.
	const client = getVertexClient() as unknown as Anthropic;
	const maxTokens = options?.maxTokens ?? model.maxTokens;
	// ponytail: no context-aware maxTokens clamp — pi-ai's clampMaxTokensToContext
	// isn't on the compat surface. Output caps rarely bind against 200K–1M windows,
	// and Vertex validates. Add a clamp if huge prompts start erroring.
	const reasoning = options?.reasoning;

	if (!reasoning) {
		return streamAnthropic(model, context, { ...options, client, maxTokens, thinkingEnabled: false });
	}
	if (model.compat?.forceAdaptiveThinking === true) {
		return streamAnthropic(model, context, { ...options, client, maxTokens, thinkingEnabled: true, effort: mapEffort(model, reasoning) });
	}
	const budget = THINKING_BUDGETS[reasoning === "xhigh" ? "high" : reasoning] ?? 8192;
	return streamAnthropic(model, context, {
		...options,
		client,
		maxTokens,
		thinkingEnabled: true,
		thinkingBudgetTokens: Math.min(budget, Math.max(0, maxTokens - 1024)),
	});
}

// =============================================================================
// Model list: derived live from pi-ai's Anthropic registry. Only the Vertex id
// differs (Vertex uses `@YYYYMMDD` version suffixes vs the API's `-YYYYMMDD`).
// =============================================================================

// Vertex requires a version suffix on the model id (`@default` for the latest,
// or `@YYYYMMDD` for a pinned version). Each model must also be enabled in the
// project's Model Garden (accept Anthropic's EULA) or requests 404.
const VERTEX_MODEL_IDS: { vertexId: string; baseId: string }[] = [
	{ vertexId: "claude-sonnet-5@default", baseId: "claude-sonnet-5" },
	{ vertexId: "claude-opus-4-8@default", baseId: "claude-opus-4-8" },
	{ vertexId: "claude-sonnet-4-6@default", baseId: "claude-sonnet-4-6" },
	{ vertexId: "claude-fable-5@default", baseId: "claude-fable-5" },
	{ vertexId: "claude-haiku-4-5@20251001", baseId: "claude-haiku-4-5-20251001" },
];

function buildModels() {
	const models = [];
	for (const { vertexId, baseId } of VERTEX_MODEL_IDS) {
		const base = getModel("anthropic", baseId) as Model<Api> | undefined;
		if (!base) {
			console.warn(`vertex-anthropic: skipping "${vertexId}" — "${baseId}" not in pi-ai's Anthropic registry.`);
			continue;
		}
		models.push({
			id: vertexId,
			name: `${base.name} (Vertex)`,
			reasoning: base.reasoning,
			thinkingLevelMap: base.thinkingLevelMap,
			input: base.input,
			cost: base.cost,
			contextWindow: base.contextWindow,
			maxTokens: base.maxTokens,
			compat: base.compat,
		});
	}
	return models;
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER, {
		// Marker only — AnthropicVertex builds per-model URLs from project+region.
		baseUrl: "https://aiplatform.googleapis.com",
		// Sentinel so pi treats models as selectable; streamSimple ignores it and
		// authenticates via ADC inside AnthropicVertex.
		apiKey: "adc",
		api: PROVIDER,
		streamSimple,
		models: buildModels(),
	});
}
