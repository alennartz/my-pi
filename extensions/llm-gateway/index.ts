import type { AnyModel, ModelsStoreEntry, RefreshModelsContext } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ProviderConfig,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { buildProviderModelConfigs } from "./catalog.js";

const PROVIDER_ID = "llmgateway";
const PROVIDER_NAME = "LLM Gateway DevPass";
const BASE_URL = "https://api.llmgateway.io/v1";
const MODELS_URL = `${BASE_URL}/models`;
const API_KEY_ENV = "LLMGATEWAY_API_KEY";
const CATALOG_MAX_AGE_MS = 60 * 60 * 1000;

function isFresh(checkedAt: unknown, now: number): checkedAt is number {
	return typeof checkedAt === "number" &&
		Number.isFinite(checkedAt) &&
		now - checkedAt < CATALOG_MAX_AGE_MS;
}

function asProviderModelConfig(model: AnyModel): ProviderModelConfig | undefined {
	if (model.provider !== PROVIDER_ID || model.api !== "openai-completions") return undefined;
	const { provider: _provider, baseUrl: _baseUrl, ...config } = model;
	return config as ProviderModelConfig;
}

function restoreStoredModels(stored: Readonly<ModelsStoreEntry> | undefined): ProviderModelConfig[] {
	if (!stored) return [];
	return stored.models
		.map(asProviderModelConfig)
		.filter((model): model is ProviderModelConfig => model !== undefined);
}

function toStoredModel(model: ProviderModelConfig): AnyModel {
	return {
		...model,
		api: model.api ?? "openai-completions",
		provider: PROVIDER_ID,
		baseUrl: BASE_URL,
	} as AnyModel;
}

function catalogRecords(payload: unknown): unknown[] {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		throw new Error("LLM Gateway /v1/models response did not contain a data array");
	}
	const data = (payload as { data?: unknown }).data;
	if (!Array.isArray(data)) {
		throw new Error("LLM Gateway /v1/models response did not contain a data array");
	}
	return data;
}

function configuredApiKey(context: RefreshModelsContext): string {
	const credential = context.credential;
	if (credential?.type === "api_key" && typeof credential.key === "string") {
		const key = credential.key.trim();
		if (key) return key;
	}
	const key = process.env[API_KEY_ENV]?.trim();
	if (key) return key;
	throw new Error(`LLM Gateway ${API_KEY_ENV} must be set`);
}

async function refreshModels(context: RefreshModelsContext): Promise<ProviderModelConfig[]> {
	if (context.signal.aborted) return [];

	const restored = restoreStoredModels(context.stored);
	if (!context.allowNetwork || context.signal.aborted) return restored;
	if (!context.force && isFresh(context.stored?.checkedAt, Date.now())) return restored;

	const response = await fetch(MODELS_URL, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${configuredApiKey(context)}`,
		},
		signal: context.signal,
	});
	if (context.signal.aborted) return [];
	if (!response.ok) {
		throw new Error(`LLM Gateway /v1/models request failed (${response.status} ${response.statusText})`);
	}

	const records = catalogRecords(await response.json());
	if (context.signal.aborted) return [];
	const models = buildProviderModelConfigs(records);
	if (context.signal.aborted) return [];

	const persisted: ModelsStoreEntry = {
		models: models.map(toStoredModel),
		checkedAt: Date.now(),
	};
	if (context.signal.aborted) return [];
	const published = await context.publish({ persist: persisted });
	if (!published || context.signal.aborted) return [];
	return models;
}

const providerConfig: ProviderConfig = {
	name: PROVIDER_NAME,
	baseUrl: BASE_URL,
	api: "openai-completions",
	apiKey: "$LLMGATEWAY_API_KEY",
	authHeader: true,
	refreshModels,
};

/** LLM Gateway DevPass provider extension. */
export default async function registerLLMGateway(pi: ExtensionAPI): Promise<void> {
	pi.registerProvider(PROVIDER_ID, providerConfig);
}
