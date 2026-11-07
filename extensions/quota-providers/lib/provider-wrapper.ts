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
const NESTED_GUARD = Symbol.for("my-pi.quota-provider-nested-guard");

type WrapperState =
	| {
		kind: "provider";
		original: Provider;
		evaluate: ProviderQuotaEvaluator;
	}
	| {
		kind: "stream";
		originalStreamSimple: Provider["streamSimple"];
		evaluate: ProviderQuotaEvaluator;
	};

type MarkedProvider = Provider & { readonly [QUOTA_WRAPPER]?: WrapperState };
type GuardOptions = SimpleStreamOptions & { [NESTED_GUARD]?: true };

function beginGuard(options: SimpleStreamOptions | undefined): boolean {
	if (!options || typeof options !== "object") return false;
	const target = options as GuardOptions;
	if (target[NESTED_GUARD]) return true;
	try {
		Object.defineProperty(target, NESTED_GUARD, {
			configurable: true,
			enumerable: false,
			value: true,
		});
		return false;
	} catch {
		return false;
	}
}

function endGuard(options: SimpleStreamOptions | undefined): void {
	if (!options || typeof options !== "object") return;
	try {
		delete (options as GuardOptions)[NESTED_GUARD];
	} catch {
		// A frozen options object cannot carry the marker.
	}
}

function releaseGuardAfterStream(options: SimpleStreamOptions | undefined, result: unknown): void {
	if (!options || typeof options !== "object") return;
	const resultMethod = (result as { result?: unknown } | null)?.result;
	if (typeof resultMethod !== "function") {
		endGuard(options);
		return;
	}
	void Promise.resolve(Reflect.apply(resultMethod, result, []))
		.then(() => endGuard(options), () => endGuard(options));
}

function wrapperState(provider: Provider): WrapperState | undefined {
	const value = (provider as unknown as Record<PropertyKey, unknown>)[QUOTA_WRAPPER];
	if (!value || typeof value !== "object") return undefined;
	const state = value as Partial<WrapperState>;
	return state.kind === "provider" || state.kind === "stream"
		? value as WrapperState
		: undefined;
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

/**
 * Install a guard on the effective provider object itself. Pi's models.json
 * composer creates a lazy stream method, so this keeps a block synchronous
 * while preserving the complete provider object.
 */
export function installQuotaStreamGuard(
	provider: Provider,
	evaluate: ProviderQuotaEvaluator,
): boolean {
	const existing = wrapperState(provider);
	if (existing) {
		existing.evaluate = evaluate;
		return true;
	}

	const originalStreamSimple = provider.streamSimple;
	const state: WrapperState = { kind: "stream", originalStreamSimple, evaluate };
	const guardedStreamSimple: Provider["streamSimple"] = (model, context, options) => {
		const nested = beginGuard(options);
		try {
			if (!nested) {
				const decision = state.evaluate(model, options);
				if (decision?.blocked) throw new Error(decision.message);
			}
			const result = Reflect.apply(state.originalStreamSimple, provider, [model, context, options]);
			if (!nested) releaseGuardAfterStream(options, result);
			return result;
		} catch (error) {
			if (!nested) endGuard(options);
			throw error;
		}
	};

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
	const state: WrapperState = { kind: "provider", original: provider, evaluate };
	const guardedStreamSimple: Provider["streamSimple"] = (model, context, options) => {
		const nested = beginGuard(options);
		try {
			if (!nested) {
				const decision = state.evaluate(model, options);
				if (decision?.blocked) throw new Error(decision.message);
			}
			const result = Reflect.apply(streamSimple, provider, [model, context, options]);
			if (!nested) releaseGuardAfterStream(options, result);
			return result;
		} catch (error) {
			if (!nested) endGuard(options);
			throw error;
		}
	};

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
