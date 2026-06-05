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
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// =============================================================================
// Configuration (from env vars)
// =============================================================================

const REQUIRED_ENV_VARS = [
	"AZURE_FOUNDRY_ENDPOINT",
	"AZURE_FOUNDRY_ACCOUNT",
	"AZURE_FOUNDRY_RESOURCE_GROUP",
] as const;

interface FoundryConfig {
	endpoint: string;
	account: string;
	resourceGroup: string;
	subscription?: string;
}

/**
 * Resolve required configuration from env vars. Returns null (rather than
 * throwing) when any required var is absent, so a misconfigured/absent Azure
 * Foundry setup degrades to a no-op instead of crashing the entire pi CLI.
 */
function resolveConfig(): FoundryConfig | null {
	const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
	if (missing.length > 0) return null;

	return {
		endpoint: process.env.AZURE_FOUNDRY_ENDPOINT!.replace(/\/+$/, ""),
		account: process.env.AZURE_FOUNDRY_ACCOUNT!,
		resourceGroup: process.env.AZURE_FOUNDRY_RESOURCE_GROUP!,
		subscription: process.env.AZURE_FOUNDRY_SUBSCRIPTION, // optional
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
// Known Model Metadata Catalog
// =============================================================================

/** Per-million-token cost rates (matches pi-ai's Model.cost format). */
interface ModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

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
 * Known model metadata, keyed by the model name from the deployment API
 * (properties.model.name). Add entries here when new model families are
 * deployed — unknown models get conservative defaults.
 *
 * Cost rates are $ per million tokens, matching pi-ai's built-in model data.
 */
const MODEL_CATALOG: Record<string, Partial<ModelMeta>> = {
	// Anthropic
	"claude-sonnet-4-5": { reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 64000,
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
	"claude-sonnet-4-6": { reasoning: true, input: ["text", "image"], contextWindow: 1000000, maxTokens: 64000,
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, forceAdaptiveThinking: true },
	"claude-opus-4-5": { reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 64000,
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
	"claude-opus-4-6": { reasoning: true, input: ["text", "image"], contextWindow: 1000000, maxTokens: 128000,
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, forceAdaptiveThinking: true },
	"claude-opus-4-7": { reasoning: true, input: ["text", "image"], contextWindow: 1000000, maxTokens: 128000,
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, forceAdaptiveThinking: true },
	"claude-opus-4-8": { reasoning: true, input: ["text", "image"], contextWindow: 1000000, maxTokens: 128000,
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, forceAdaptiveThinking: true },
	"claude-haiku-4-5": { reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 64000,
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
	// OpenAI — GPT-4.1 family
	"gpt-4.1": { reasoning: false, input: ["text", "image"], contextWindow: 1047576, maxTokens: 32768,
		cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 } },
	"gpt-4.1-mini": { reasoning: false, input: ["text", "image"], contextWindow: 1047576, maxTokens: 32768,
		cost: { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0 } },
	"gpt-4.1-nano": { reasoning: false, input: ["text", "image"], contextWindow: 1047576, maxTokens: 32768,
		cost: { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0 } },
	// OpenAI — O-series reasoning
	"o3": { reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 100000,
		cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 } },
	"o3-pro": { reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 100000,
		cost: { input: 20, output: 80, cacheRead: 20, cacheWrite: 0 } },
	"o3-mini": { reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 100000,
		cost: { input: 1.1, output: 4.4, cacheRead: 0.55, cacheWrite: 0 } },
	"o4-mini": { reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 100000,
		cost: { input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 0 } },
	// OpenAI — GPT-5 family
	"gpt-5": { reasoning: true, input: ["text", "image"], contextWindow: 400000, maxTokens: 128000,
		cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 } },
	"gpt-5-pro": { reasoning: true, input: ["text", "image"], contextWindow: 400000, maxTokens: 272000,
		cost: { input: 15, output: 120, cacheRead: 15, cacheWrite: 0 } },
	"gpt-5-mini": { reasoning: true, input: ["text", "image"], contextWindow: 400000, maxTokens: 128000,
		cost: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 } },
	"gpt-5-nano": { reasoning: true, input: ["text", "image"], contextWindow: 400000, maxTokens: 128000,
		cost: { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0 } },
	// OpenAI — GPT-5.1
	"gpt-5.1": { reasoning: true, input: ["text", "image"], contextWindow: 400000, maxTokens: 128000,
		cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 } },
	// OpenAI — GPT-5.2 family
	"gpt-5.2": { reasoning: true, input: ["text", "image"], contextWindow: 400000, maxTokens: 128000,
		cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 } },
	"gpt-5.2-pro": { reasoning: true, input: ["text", "image"], contextWindow: 400000, maxTokens: 128000,
		cost: { input: 21, output: 168, cacheRead: 21, cacheWrite: 0 } },
	"gpt-5.2-codex": { reasoning: true, input: ["text"], contextWindow: 400000, maxTokens: 128000,
		cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 } },
	// OpenAI — GPT-5.3
	"gpt-5.3-codex": { reasoning: true, input: ["text"], contextWindow: 400000, maxTokens: 128000,
		cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 } },
	// OpenAI — GPT-5.4 family
	"gpt-5.4": { reasoning: true, input: ["text", "image"], contextWindow: 272000, maxTokens: 128000,
		cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 } },
	"gpt-5.4-pro": { reasoning: true, input: ["text", "image"], contextWindow: 1050000, maxTokens: 128000,
		cost: { input: 30, output: 180, cacheRead: 30, cacheWrite: 0 } },
	"gpt-5.4-mini": { reasoning: true, input: ["text", "image"], contextWindow: 400000, maxTokens: 128000,
		cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 } },
	"gpt-5.4-nano": { reasoning: true, input: ["text", "image"], contextWindow: 400000, maxTokens: 128000,
		cost: { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 } },
	// OpenAI — GPT-5.5 family
	"gpt-5.5": { reasoning: true, input: ["text", "image"], contextWindow: 272000, maxTokens: 128000,
		cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 } },
	"gpt-5.5-pro": { reasoning: true, input: ["text", "image"], contextWindow: 1050000, maxTokens: 128000,
		cost: { input: 30, output: 180, cacheRead: 30, cacheWrite: 0 } },
};

function lookupMeta(modelName: string): ModelMeta {
	const override = MODEL_CATALOG[modelName];
	if (!override) return { ...DEFAULTS };
	return { ...DEFAULTS, ...override };
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
	if (!config) {
		// Required env vars absent — degrade to a no-op so pi can still start.
		console.warn(
			`azure-foundry: skipping registration — missing required env var(s): ${REQUIRED_ENV_VARS.filter(
				(name) => !process.env[name],
			).join(", ")}`,
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
				const meta = lookupMeta(d.modelName);
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
