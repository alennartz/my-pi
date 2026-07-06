/**
 * Azure AI Foundry Provider Extension
 *
 * Auto-discovers model deployments from an Azure AI Foundry resource and registers
 * them as pi models. Supports multiple backend formats (Anthropic, OpenAI) with
 * dynamic Azure AD token refresh.
 *
 * Solves https://github.com/badlogic/pi-mono/issues/1835 by fetching tokens at
 * request time instead of at model-parse time.
 *
 * Required env vars:
 *   AZURE_FOUNDRY_ENDPOINT       - e.g. https://my-foundry.services.ai.azure.com
 *   AZURE_FOUNDRY_ACCOUNT        - Cognitive Services account name
 *   AZURE_FOUNDRY_RESOURCE_GROUP - Azure resource group
 *
 * Optional env vars:
 *   AZURE_FOUNDRY_SUBSCRIPTION   - Subscription name or ID (if not the default)
 *   AZURE_FOUNDRY_TOKEN_RESOURCE - AAD audience for the access token
 *                                  (default: https://cognitiveservices.azure.com)
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";

// =============================================================================
// Configuration (from env vars)
// =============================================================================

const REQUIRED_ENV_VARS = [
	"AZURE_FOUNDRY_ENDPOINT",
	"AZURE_FOUNDRY_ACCOUNT",
	"AZURE_FOUNDRY_RESOURCE_GROUP",
] as const;

/**
 * Resolved configuration. Only `endpoint` is consumed here; the helper process
 * reads the account/resource-group/subscription env vars itself.
 */
type ConfigResult = { ok: true; endpoint: string } | { ok: false; missing: string[] };

/**
 * Resolve required configuration from env vars. Returns `{ ok: false, missing }`
 * (rather than throwing) when any required var is absent, so a
 * misconfigured/absent Azure Foundry setup degrades to a no-op instead of
 * crashing the entire pi CLI. The caller reports the missing list.
 */
function resolveConfig(): ConfigResult {
	const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
	if (missing.length > 0) return { ok: false, missing: [...missing] };

	return {
		ok: true,
		endpoint: process.env.AZURE_FOUNDRY_ENDPOINT!.replace(/\/+$/, ""),
	};
}

// =============================================================================
// Cache & Helper Plumbing
// =============================================================================
//
// All `az` CLI work (token fetch + deployment discovery) is pushed into the
// out-of-band Node helper (foundry-helper.mjs) so it never runs synchronously
// on pi's extension-factory path. See docs/plans/azure-foundry-refactor.md.

/** Background-refresh cadence. */
const REFRESH_FLOOR_MS = 30 * 1000; // cold start: skip refresh if cache younger than this
const REFRESH_TTL_MS = 60 * 60 * 1000; // /new or /reload: only refresh if cache older than this

/** Absolute path to the out-of-band Node helper (token + discovery). */
const HELPER_PATH = fileURLToPath(new URL("./foundry-helper.mjs", import.meta.url));

/**
 * The runtime executing pi (node, or a bundled bun binary). Used instead of a
 * bare `node` so the helper runs even when `node` isn't on PATH. Both node and
 * bun can execute the `.mjs` helper.
 */
const NODE_BIN = process.execPath;

function resolveAgentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env) return env.startsWith("~/") ? join(homedir(), env.slice(2)) : env;
	return join(homedir(), ".pi", "agent");
}

const CACHE_DIR = join(resolveAgentDir(), "cache", "azure-foundry");
const TOKEN_CACHE_PATH = join(CACHE_DIR, "token.json");
const DEPLOYMENTS_CACHE_PATH = join(CACHE_DIR, "deployments.json");

interface CachedDeployment {
	deploymentName: string;
	modelName: string;
	backend: Backend;
}
interface DeploymentsCache {
	writtenAt: number;
	deployments: CachedDeployment[];
}

function readDeploymentsCache(path: string): DeploymentsCache | null {
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as DeploymentsCache;
		if (Array.isArray(parsed?.deployments)) return parsed;
	} catch {
		// torn/garbage cache — treat as miss
	}
	return null;
}

/** Block-once discovery on a cold cache miss. Throws on failure. */
function runRefreshSync(depCachePath: string): void {
	execFileSync(NODE_BIN, [HELPER_PATH, "refresh-deployments", "--cache", depCachePath], {
		stdio: "ignore",
		timeout: 35_000,
	});
}

/** Fire-and-forget background discovery refresh; never blocks, never throws. */
function spawnRefreshDetached(depCachePath: string): void {
	try {
		const child = spawn(NODE_BIN, [HELPER_PATH, "refresh-deployments", "--cache", depCachePath], {
			detached: true,
			stdio: "ignore",
		});
		child.unref();
	} catch {
		// best-effort
	}
}

// =============================================================================
// Backend Definitions
// =============================================================================

type Backend = "anthropic-messages" | "openai-responses" | "openai-completions";

interface BackendConfig {
	/** Base path appended to the Foundry endpoint */
	basePath: string;
	/**
	 * Whether pi should add `Authorization: Bearer <token>` from the resolved
	 * apiKey. Anthropic needs it (the Anthropic SDK would otherwise authenticate
	 * via x-api-key only, which Azure Foundry rejects). The OpenAI SDKs already
	 * send `Authorization: Bearer <apiKey>` natively, so it's unnecessary there.
	 */
	authHeader: boolean;
}

const BACKENDS: Record<Backend, BackendConfig> = {
	"anthropic-messages": { basePath: "/anthropic", authHeader: true },
	"openai-responses": { basePath: "/openai/v1", authHeader: false },
	"openai-completions": { basePath: "/openai/v1", authHeader: false },
};

// =============================================================================
// Model Metadata (delegated to pi-ai's bundled catalog)
// =============================================================================

/** Per-million-token cost rates. Sourced directly from pi-ai's `Model.cost`. */
type ModelCost = Model<Api>["cost"];

interface ModelMeta {
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	cost: ModelCost;
	/**
	 * Anthropic only. Tells pi-ai to use adaptive thinking
	 * (`thinking.type="adaptive"` + `output_config.effort`) instead of
	 * budget-based thinking (`thinking.type="enabled"` + `budget_tokens`).
	 * Required for Opus 4.6+, Opus 4.7, Sonnet 4.6 — Azure Foundry rejects the
	 * older shape for these models.
	 */
	forceAdaptiveThinking?: boolean;
}

const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const DEFAULTS: ModelMeta = {
	reasoning: false,
	input: ["text"],
	contextWindow: 128000,
	maxTokens: 16384,
	cost: ZERO_COST,
};

/**
 * pi-ai model providers that carry the correct metadata for each Foundry
 * backend. Azure Foundry's OpenAI deployments use `azure-openai-responses`,
 * whose context windows match Azure (e.g. GPT-5.4/5.5 = 1,050,000) rather than
 * OpenAI's smaller public limits. Anthropic deployments use `anthropic`.
 */
const PI_AI_PROVIDER: Record<Backend, "anthropic" | "azure-openai-responses"> = {
	"anthropic-messages": "anthropic",
	"openai-responses": "azure-openai-responses",
	"openai-completions": "azure-openai-responses",
};

/**
 * Resolve model metadata from pi-ai's built-in catalog, keyed by the model name
 * from the deployment API (properties.model.name) under the backend's provider.
 * Unknown models fall back to conservative defaults. Delegating to pi-ai keeps
 * cost / context / adaptive-thinking data in sync with the bundled model data
 * instead of a hand-maintained table that silently drifts from upstream.
 */
function lookupMeta(backend: Backend, modelName: string): ModelMeta {
	// `modelName` is a free-form deployment model name, not one of getModel's
	// statically-known model-id union members; cast to satisfy the parameter
	// type. A miss returns undefined, which is handled by the fallback below.
	const model = getModel(PI_AI_PROVIDER[backend], modelName as never);
	if (!model) return { ...DEFAULTS };
	return {
		reasoning: model.reasoning ?? false,
		input: model.input as ("text" | "image")[],
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		cost: model.cost,
		forceAdaptiveThinking: model.compat?.forceAdaptiveThinking,
	};
}

// Deployment discovery now lives in foundry-helper.mjs (refresh-deployments),
// run out-of-band so it never blocks pi's extension-factory path. Stream routing
// is handled by pi's built-in api streamers (no custom streamSimple), so this
// provider can no longer hijack traffic for other providers sharing its api.

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
	const config = resolveConfig();
	if (!config.ok) {
		// Required env vars absent — degrade to a no-op so pi can still start.
		console.warn(
			`azure-foundry: skipping registration — missing required env var(s): ${config.missing.join(", ")}`,
		);
		return;
	}

	// Distinguish process cold start from /new or /reload within the same process.
	// jiti loads extensions with moduleCache:false, so module scope is wiped on
	// every factory re-run — a globalThis sentinel survives re-imports within one
	// process but is fresh in every new process.
	const SENTINEL = Symbol.for("azure-foundry/process-seen");
	const g = globalThis as Record<symbol, unknown>;
	const firstRunInProcess = !g[SENTINEL];
	g[SENTINEL] = true;

	let cache = readDeploymentsCache(DEPLOYMENTS_CACHE_PATH);

	if (!cache) {
		// Cold cache miss: block once to populate it, then read it back.
		try {
			runRefreshSync(DEPLOYMENTS_CACHE_PATH);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`azure-foundry: skipping registration — ${msg}`);
			return;
		}
		cache = readDeploymentsCache(DEPLOYMENTS_CACHE_PATH);
		if (!cache) {
			console.warn("azure-foundry: skipping registration — discovery produced no cache");
			return;
		}
	} else {
		// Warm cache: maybe kick a detached background refresh for next time.
		//  - cold start: always, unless the cache is younger than the floor (absorbs
		//    bursts of process/subagent spawns).
		//  - /new or /reload: only when older than the TTL (don't spawn az per /new).
		const age = Date.now() - (cache.writtenAt ?? 0);
		const due = firstRunInProcess ? age > REFRESH_FLOOR_MS : age > REFRESH_TTL_MS;
		if (due) spawnRefreshDetached(DEPLOYMENTS_CACHE_PATH);
	}

	if (cache.deployments.length === 0) {
		console.warn("azure-foundry: no chat-capable deployments found — nothing to register");
		return;
	}

	// Group deployments by backend
	const byBackend = new Map<Backend, CachedDeployment[]>();
	for (const d of cache.deployments) {
		const group = byBackend.get(d.backend) ?? [];
		group.push(d);
		byBackend.set(d.backend, group);
	}

	// Register one provider per backend — each gets the correct api string
	const FRIENDLY_NAMES: Record<Backend, string> = {
		"anthropic-messages": "Azure Foundry (Anthropic Messages)",
		"openai-responses": "Azure Foundry (OpenAI Responses)",
		"openai-completions": "Azure Foundry (OpenAI Completions)",
	};

	// pi runs this per request as the apiKey; the helper self-caches the token.
	// Quoted so paths with spaces survive pi's /bin/sh -c invocation.
	const tokenCommand = `!"${NODE_BIN}" "${HELPER_PATH}" token --cache "${TOKEN_CACHE_PATH}"`;

	for (const [backend, group] of byBackend) {
		const cfg = BACKENDS[backend];
		pi.registerProvider(`azure-foundry-${backend}`, {
			name: FRIENDLY_NAMES[backend],
			baseUrl: `${config.endpoint}${cfg.basePath}`,
			apiKey: tokenCommand,
			authHeader: cfg.authHeader,
			api: backend,

			models: group.map((d) => {
				const meta = lookupMeta(backend, d.modelName);
				return {
					id: d.deploymentName,
					name: d.deploymentName,
					reasoning: meta.reasoning,
					input: meta.input,
					cost: meta.cost,
					contextWindow: meta.contextWindow,
					maxTokens: meta.maxTokens,
					...(backend === "anthropic-messages" && meta.forceAdaptiveThinking
						? { compat: { forceAdaptiveThinking: true } }
						: {}),
				};
			}),
		});
	}
}
