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

const QUOTA_WRAPPER = Symbol("quota-provider-wrapper");

type WrappedProvider = Provider & {
	readonly [QUOTA_WRAPPER]?: true;
};

/**
 * Return a complete provider whose stream is guarded by quota policy.
 * Every non-stream operation and provider-owned field stays unchanged.
 */
export function wrapProviderWithQuota(
	provider: Provider,
	evaluate: ProviderQuotaEvaluator,
): Provider {
	if (Object.prototype.hasOwnProperty.call(provider, QUOTA_WRAPPER)) return provider;

	const streamSimple = provider.streamSimple;
	const guardedStreamSimple: Provider["streamSimple"] = (model, context, options) => {
		const decision = evaluate(model, options);
		if (decision?.blocked) throw new Error(decision.message);
		return Reflect.apply(streamSimple, provider, [model, context, options]);
	};

	const target = Object.create(provider) as WrappedProvider;
	Object.defineProperty(target, QUOTA_WRAPPER, {
		configurable: false,
		enumerable: false,
		value: true,
		writable: false,
	});

	return new Proxy(target, {
		get(wrapper, property) {
			if (property === QUOTA_WRAPPER) return wrapper[QUOTA_WRAPPER];
			if (property === "streamSimple") return guardedStreamSimple;

			const value = Reflect.get(provider, property, provider);
			return typeof value === "function" ? value.bind(provider) : value;
		},
	}) as Provider;
}
