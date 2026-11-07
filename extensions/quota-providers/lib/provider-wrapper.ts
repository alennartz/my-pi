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

// Symbol.for keeps the marker visible when pi reloads an extension module in
// the same process. A local Symbol would make old guards look like new ones.
const QUOTA_WRAPPER = Symbol.for("my-pi.quota-provider-wrapper");

/** Closed-over dispatch state shared by nested provider-composer calls. */
export type QuotaGuardChain = { depth: number };

type WrapperState =
	| {
		kind: "provider";
		original: Provider;
		evaluate: ProviderQuotaEvaluator;
		chain: QuotaGuardChain;
	}
	| {
		kind: "stream";
		originalStreamSimple: Provider["streamSimple"];
		evaluate: ProviderQuotaEvaluator;
		chain: QuotaGuardChain;
	};

type MarkedProvider = Provider & { readonly [QUOTA_WRAPPER]?: WrapperState };

function wrapperState(provider: Provider): WrapperState | undefined {
	const value = (provider as unknown as Record<PropertyKey, unknown>)[QUOTA_WRAPPER];
	if (!value || typeof value !== "object") return undefined;
	const state = value as Partial<WrapperState>;
	return state.kind === "provider" || state.kind === "stream"
		? value as WrapperState
		: undefined;
}

/** Return the private dispatch chain for a quota wrapper. */
export function quotaGuardChain(provider: Provider): QuotaGuardChain | undefined {
	return wrapperState(provider)?.chain;
}

/** Return whether a provider carries one of this extension's guards. */
export function isQuotaWrappedProvider(provider: Provider): boolean {
	return wrapperState(provider) !== undefined;
}

/**
 * Remove quota guards from a provider and return the underlying provider.
 * Stream guards are restored in place so a reloaded extension starts clean.
 */
export function unwrapQuotaProvider(provider: Provider): Provider {
	let current = provider;
	const seen = new Set<Provider>();
	while (!seen.has(current)) {
		seen.add(current);
		const state = wrapperState(current);
		if (!state) return current;
		if (state.kind === "stream") {
			restoreQuotaStreamGuard(current);
			return current;
		}
		current = state.original;
	}
	return current;
}

/** Restore a guard installed directly on a provider object. */
export function restoreQuotaStreamGuard(provider: Provider): boolean {
	const state = wrapperState(provider);
	if (!state || state.kind !== "stream") return false;
	try {
		Object.defineProperty(provider, "streamSimple", {
			configurable: true,
			enumerable: true,
			writable: true,
			value: state.originalStreamSimple,
		});
		return delete (provider as unknown as Record<PropertyKey, unknown>)[QUOTA_WRAPPER];
	} catch {
		return false;
	}
}

function guardedStream(
	chain: QuotaGuardChain,
	evaluate: ProviderQuotaEvaluator,
	original: Provider["streamSimple"],
	receiver: Provider,
): Provider["streamSimple"] {
	return (model, context, options) => {
		const nested = chain.depth > 0;
		chain.depth += 1;
		try {
			if (!nested) {
				const decision = evaluate(model, options);
				if (decision?.blocked) throw new Error(decision.message);
			}
			return Reflect.apply(original, receiver, [model, context, options]);
		} finally {
			chain.depth -= 1;
		}
	};
}

/**
 * Install a guard on the effective provider object itself. Pi's models.json
 * composer creates a lazy stream method, so this keeps a block synchronous
 * while preserving the complete provider object.
 */
export function installQuotaStreamGuard(
	provider: Provider,
	evaluate: ProviderQuotaEvaluator,
	chain: QuotaGuardChain = { depth: 0 },
): boolean {
	const existing = wrapperState(provider);
	if (existing) {
		existing.evaluate = evaluate;
		return true;
	}

	const originalStreamSimple = provider.streamSimple;
	const state: WrapperState = { kind: "stream", originalStreamSimple, evaluate, chain };
	const guardedStreamSimple = guardedStream(chain, evaluate, originalStreamSimple, provider);

	try {
		Object.defineProperty(provider, QUOTA_WRAPPER, {
			configurable: true,
			enumerable: false,
			writable: false,
			value: state,
		});
		Object.defineProperty(provider, "streamSimple", {
			configurable: true,
			enumerable: true,
			writable: true,
			value: guardedStreamSimple,
		});
		return true;
	} catch {
		try {
			delete (provider as unknown as Record<PropertyKey, unknown>)[QUOTA_WRAPPER];
		} catch {
			// The provider is immutable. The caller can fall back to a Proxy.
		}
		return false;
	}
}

/**
 * Return a complete provider whose stream is guarded by quota policy.
 * Every non-stream operation and provider-owned field stays unchanged.
 */
export function wrapProviderWithQuota(
	provider: Provider,
	evaluate: ProviderQuotaEvaluator,
): Provider {
	const existing = wrapperState(provider);
	if (existing) {
		existing.evaluate = evaluate;
		return provider;
	}

	const streamSimple = provider.streamSimple;
	const chain: QuotaGuardChain = { depth: 0 };
	const state: WrapperState = { kind: "provider", original: provider, evaluate, chain };
	const guardedStreamSimple = guardedStream(chain, evaluate, streamSimple, provider);

	const target = Object.create(provider) as MarkedProvider;
	Object.defineProperty(target, QUOTA_WRAPPER, {
		configurable: false,
		enumerable: false,
		value: state,
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
