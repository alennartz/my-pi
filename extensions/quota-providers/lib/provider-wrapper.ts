import type { Api, Model, Provider, SimpleStreamOptions } from "@earendil-works/pi-ai";

/** A decision returned immediately before a provider stream starts. */
export type ProviderQuotaDecision =
	| { blocked: false }
	| { blocked: true; kind: "soft" | "hard"; message: string }
	| undefined;

/**
 * Evaluates the selected model at the provider boundary. The request options
 * carry the session identity used to resolve tree-scoped bypass state.
 */
export type ProviderQuotaEvaluator = (
	model: Model<Api>,
	options?: SimpleStreamOptions,
) => ProviderQuotaDecision;

/**
 * Return a complete provider whose stream is guarded by quota policy.
 * Every non-stream operation and provider-owned field stays unchanged.
 */
export function wrapProviderWithQuota(
	_provider: Provider,
	_evaluate: ProviderQuotaEvaluator,
): Provider {
	throw new Error("not implemented");
}
