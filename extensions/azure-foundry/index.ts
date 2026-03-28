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

import { execSync } from "node:child_process";
import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	streamSimpleAnthropic,
	streamSimpleOpenAICompletions,
	streamSimpleOpenAIResponses,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// =============================================================================
// Configuration (from env vars)
// =============================================================================

function requireEnv(name: string): string {
	const val = process.env[name];
	if (!val) throw new Error(`azure-foundry: missing required env var ${name}`);
	return val;
}

const ENDPOINT = requireEnv("AZURE_FOUNDRY_ENDPOINT").replace(/\/+$/, "");
const ACCOUNT = requireEnv("AZURE_FOUNDRY_ACCOUNT");
const RESOURCE_GROUP = requireEnv("AZURE_FOUNDRY_RESOURCE_GROUP");
const SUBSCRIPTION = process.env.AZURE_FOUNDRY_SUBSCRIPTION; // optional

// =============================================================================
// Azure AD Token Cache
// =============================================================================

const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // try to refresh 5 min before expiry
const TOKEN_HARD_MARGIN_MS = 30 * 1000; // absolute minimum — never use a token closer than 30s to expiry
const AZ_TOKEN_CMD =
	"az account get-access-token --resource https://cognitiveservices.azure.com -o json";

let cachedToken: { value: string; expiresAt: number } | null = null;

function getAzureToken(): string {
	const now = Date.now();
	if (cachedToken && now < cachedToken.expiresAt) {
		return cachedToken.value;
	}

	const raw = execSync(AZ_TOKEN_CMD, { encoding: "utf-8", timeout: 15_000 }).trim();
	if (!raw) {
		throw new Error("azure-foundry: az CLI returned empty response. Is `az login` still valid?");
	}

	const parsed = JSON.parse(raw) as { accessToken: string; expiresOn: string };
	const token = parsed.accessToken;
	if (!token) {
		throw new Error("azure-foundry: az CLI returned no accessToken. Is `az login` still valid?");
	}

	// expiresOn is like "2026-03-07 22:28:00.000000" (local time) or an ISO string
	const expiresAt = new Date(parsed.expiresOn).getTime();
	if (Number.isNaN(expiresAt)) {
		throw new Error(`azure-foundry: could not parse expiresOn: "${parsed.expiresOn}"`);
	}

	// Prefer refreshing 5 min early, but if az CLI returned a token that's already
	// inside that window (because az CLI caches aggressively), don't discard it —
	// use it until 30s before actual expiry to avoid hammering az on every request.
	const softExpiry = expiresAt - TOKEN_REFRESH_MARGIN_MS;
	const hardExpiry = expiresAt - TOKEN_HARD_MARGIN_MS;
	cachedToken = { value: token, expiresAt: Math.max(softExpiry, Math.min(hardExpiry, now + TOKEN_HARD_MARGIN_MS)) };
	return token;
}

// =============================================================================
// Backend Definitions
// =============================================================================

type Backend = "anthropic-messages" | "openai-responses" | "openai-completions";

interface BackendConfig {
	/** Base path appended to the Foundry endpoint */
	basePath: string;
	/** Build request headers for this backend given an Azure AD token */
	buildHeaders: (token: string) => Record<string, string>;
	/** Value to pass as options.apiKey (some SDKs require a non-empty string) */
	apiKeyValue: string | ((token: string) => string);
	/** The built-in pi-ai stream function to delegate to */
	streamFn: (
		model: Model<any>,
		context: Context,
		options?: SimpleStreamOptions,
	) => AssistantMessageEventStream;
}

/**
 * Backend routing configuration.
 *
 * Anthropic: Uses Bearer token via explicit header (Anthropic SDK sends x-api-key
 * by default, which Azure Foundry doesn't accept — so we override with Authorization).
 *
 * OpenAI: The OpenAI SDK sends apiKey as "Authorization: Bearer <key>" natively,
 * so we can pass the Azure AD token directly as the apiKey.
 *
 * Adjust basePath / headers here if your Foundry resource uses different URL
 * patterns or auth methods per backend.
 */
const BACKENDS: Record<Backend, BackendConfig> = {
	"anthropic-messages": {
		basePath: "/anthropic",
		buildHeaders: (token) => ({ Authorization: `Bearer ${token}` }),
		apiKeyValue: "azure-foundry", // dummy — real auth via headers
		streamFn: streamSimpleAnthropic,
	},
	"openai-responses": {
		basePath: "/openai/v1",
		buildHeaders: () => ({}), // OpenAI SDK handles auth via apiKey
		apiKeyValue: (token) => token, // passed as Bearer token by the SDK
		streamFn: streamSimpleOpenAIResponses,
	},
	"openai-completions": {
		basePath: "/openai/v1",
		buildHeaders: () => ({}),
		apiKeyValue: (token) => token,
		streamFn: streamSimpleOpenAICompletions,
	},
};

// =============================================================================
// Known Model Metadata Catalog
// =============================================================================

interface ModelMeta {
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
}

const DEFAULTS: ModelMeta = {
	reasoning: false,
	input: ["text"],
	contextWindow: 128000,
	maxTokens: 16384,
};

/**
 * Known model metadata, keyed by the model name from the deployment API
 * (properties.model.name). Add entries here when new model families are
 * deployed — unknown models get conservative defaults.
 */
const MODEL_CATALOG: Record<string, Partial<ModelMeta>> = {
	// Anthropic
	"claude-sonnet-4-5": { reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 64000 },
	"claude-sonnet-4-6": { reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 64000 },
	"claude-opus-4-5": { reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 32000 },
	"claude-opus-4-6": { reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 64000 },
	"claude-haiku-4-5": { reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 64000 },
	// OpenAI
	"gpt-4.1": { reasoning: false, input: ["text", "image"], contextWindow: 1048576, maxTokens: 32768 },
	"gpt-5.2-codex": { reasoning: true, input: ["text"], contextWindow: 1048576, maxTokens: 65536 },
	"gpt-5.3-codex": { reasoning: true, input: ["text"], contextWindow: 1048576, maxTokens: 65536 },
};

function lookupMeta(modelName: string): ModelMeta {
	const override = MODEL_CATALOG[modelName];
	if (!override) return { ...DEFAULTS };
	return { ...DEFAULTS, ...override };
}

// =============================================================================
// Deployment Discovery
// =============================================================================

interface Deployment {
	/** Deployment name (used as model ID in API calls) */
	deploymentName: string;
	/** Underlying model name from the deployment */
	modelName: string;
	/** Model format from the deployment (e.g. "Anthropic", "OpenAI") */
	format: string;
	/** Resolved backend for stream routing */
	backend: Backend;
	/** Deployment capabilities */
	capabilities: Record<string, string>;
}

/**
 * Determine the backend for a deployment based on its format and capabilities.
 */
function resolveBackend(format: string, capabilities: Record<string, string>): Backend | null {
	if (format === "Anthropic") {
		return "anthropic-messages";
	}
	if (format === "OpenAI") {
		if (capabilities.responses === "true") return "openai-responses";
		if (capabilities.chatCompletion === "true") return "openai-completions";
	}
	// Unknown format or non-chat model (embeddings, etc.)
	return null;
}

/**
 * Discover deployments from the Azure AI Foundry resource via az CLI.
 * Filters to only chat-capable, successfully provisioned deployments.
 */
function discoverDeployments(): Deployment[] {
	const subArg = SUBSCRIPTION ? ` --subscription "${SUBSCRIPTION}"` : "";
	const cmd =
		`az cognitiveservices account deployment list` +
		` -n ${ACCOUNT} -g ${RESOURCE_GROUP}${subArg} -o json`;

	let raw: string;
	try {
		raw = execSync(cmd, { encoding: "utf-8", timeout: 30_000 });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`azure-foundry: failed to discover deployments: ${msg}`);
	}

	const items = JSON.parse(raw) as Array<{
		name: string;
		properties: {
			provisioningState: string;
			model: { format: string; name: string };
			capabilities: Record<string, string>;
		};
	}>;

	const deployments: Deployment[] = [];

	for (const item of items) {
		if (item.properties.provisioningState !== "Succeeded") continue;

		const format = item.properties.model.format;
		const capabilities = item.properties.capabilities ?? {};
		const backend = resolveBackend(format, capabilities);

		if (!backend) continue; // skip embeddings, unknown formats

		deployments.push({
			deploymentName: item.name,
			modelName: item.properties.model.name,
			format,
			backend,
			capabilities,
		});
	}

	return deployments;
}

// =============================================================================
// Stream Router
// =============================================================================

/** Map from deployment name → Deployment for O(1) lookup at stream time */
let deploymentMap: Map<string, Deployment>;

function streamAzureFoundry(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const deployment = deploymentMap.get(model.id);
	if (!deployment) {
		throw new Error(`azure-foundry: unknown deployment "${model.id}"`);
	}

	const cfg = BACKENDS[deployment.backend];
	const token = getAzureToken();
	const apiKeyValue = typeof cfg.apiKeyValue === "function" ? cfg.apiKeyValue(token) : cfg.apiKeyValue;
	const headers = { ...options?.headers, ...cfg.buildHeaders(token) };

	return cfg.streamFn(model as Model<any>, context, {
		...options,
		apiKey: apiKeyValue,
		headers,
	});
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
	const deployments = discoverDeployments();
	deploymentMap = new Map(deployments.map((d) => [d.deploymentName, d]));

	// Group deployments by backend
	const byBackend = new Map<Backend, Deployment[]>();
	for (const d of deployments) {
		const group = byBackend.get(d.backend) ?? [];
		group.push(d);
		byBackend.set(d.backend, group);
	}

	// Register one provider per backend — each gets the correct api string
	for (const [backend, group] of byBackend) {
		const cfg = BACKENDS[backend];
		pi.registerProvider(`azure-foundry-${backend}`, {
			baseUrl: `${ENDPOINT}${cfg.basePath}`,
			apiKey: "azure-foundry-dynamic",
			api: backend,

			models: group.map((d) => {
				const meta = lookupMeta(d.modelName);
				return {
					id: d.deploymentName,
					name: `Foundry ${d.deploymentName}`,
					reasoning: meta.reasoning,
					input: meta.input,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: meta.contextWindow,
					maxTokens: meta.maxTokens,
				};
			}),

			streamSimple: streamAzureFoundry,
		});
	}
}
