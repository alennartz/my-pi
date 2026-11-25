import type { Api, Model, Provider, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { GlobalSlot } from "../../subagents/global-slot.js";
import { isObjectLike } from "../../subagents/narrow.js";

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

type WrapperStateLookup = WeakMap<Provider, WrapperState>;

/** Whether a slot occupant is a wrapper-state lookup. */
function isWrapperStateLookup(value: unknown): value is WrapperStateLookup {
	return isObjectLike(value) && "get" in value && "set" in value && "delete" in value
		&& typeof value.get === "function" && typeof value.set === "function"
		&& typeof value.delete === "function";
}

// Symbol.for keeps the slot visible when pi reloads an extension module in the
// same process: the reloaded module instance shares this state with the guard
// the previous instance installed, so wrappers never stack across a reload.
const wrapperStateSlot = new GlobalSlot<WrapperStateLookup>(
	"my-pi.quota-provider-wrapper-states",
	isWrapperStateLookup,
	() => new WeakMap<Provider, WrapperState>(),
);

/** Read the wrapper state recorded for one provider object or its wrapper chain. */
function wrapperState(provider: Provider): WrapperState | undefined {
	let current: Provider | undefined = provider;
	for (let hop = 0; current !== undefined && hop < 8; hop++) {
		const recorded = wrapperStateSlot.value().get(current);
		if (recorded !== undefined) {return recorded;}
		const prototype: unknown = Object.getPrototypeOf(current);
		current = typeof prototype === "object" && prototype !== null && "id" in prototype
			? prototype as Provider
			: undefined;
	}
	return undefined;
}

/** Record wrapper state for one provider object. */
function publishWrapperState(provider: Provider, state: WrapperState): void {
	wrapperStateSlot.value().set(provider, state);
}

/** Forget wrapper state for one provider object. */
function dropWrapperState(provider: Provider): void {
	wrapperStateSlot.value().delete(provider);
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
		if (!state) {return current;}
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
	if (!state || state.kind !== "stream") {return false;}
	try {
		Object.defineProperty(provider, "streamSimple", {
			configurable: true,
			enumerable: true,
			writable: true,
			value: state.originalStreamSimple,
		});
		dropWrapperState(provider);
		return true;
	} catch {
		return false;
	}
}

type GuardState = {
	chain: QuotaGuardChain;
	evaluate: ProviderQuotaEvaluator;
};

function guardedStream(
	state: GuardState,
	original: Provider["streamSimple"],
	receiver: Provider,
): Provider["streamSimple"] {
	return (model, context, options) => {
		const nested = state.chain.depth > 0;
		state.chain.depth += 1;
		try {
			if (!nested) {
				const decision = state.evaluate(model, options);
				if (decision?.blocked) {throw new Error(decision.message);}
			}
			return original.call(receiver, model, context, options);
		} finally {
			state.chain.depth -= 1;
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

	// guardedStream supplies the receiver when it calls this method.
	// oxlint-disable-next-line typescript/unbound-method
	const originalStreamSimple = provider.streamSimple;
	const state: WrapperState = { kind: "stream", originalStreamSimple, evaluate, chain };
	const guardedStreamSimple = guardedStream(state, originalStreamSimple, provider);

	publishWrapperState(provider, state);
	try {
		Object.defineProperty(provider, "streamSimple", {
			configurable: true,
			enumerable: true,
			writable: true,
			value: guardedStreamSimple,
		});
		return true;
	} catch {
		// The provider is immutable. The caller can fall back to a Proxy.
		dropWrapperState(provider);
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
	const existing = wrapperState(provider) ?? wrapperState(Object.getPrototypeOf(provider) as Provider);
	if (existing) {
		existing.evaluate = evaluate;
		return provider;
	}

	// guardedStream supplies the receiver when it calls this method.
	// oxlint-disable-next-line typescript/unbound-method
	const streamSimple = provider.streamSimple;
	const chain: QuotaGuardChain = { depth: 0 };
	const state: WrapperState = { kind: "provider", original: provider, evaluate, chain };
	const guardedStreamSimple = guardedStream(state, streamSimple, provider);

	const target = Object.create(provider) as Provider;
	publishWrapperState(provider, state);
	publishWrapperState(target, state);

	return new Proxy(target, {
		get(wrapper, property) {
			if (property === "streamSimple") {return guardedStreamSimple;}
			if (typeof property !== "string" || !(property in provider)) {return undefined;}
			return forwardProviderMember(provider, property as keyof Provider & string);
		},
	});
}

/**
 * Forward one provider member to a caller, binding functions to the provider.
 * Typed against the declared Provider surface, so every forwarded member keeps
 * its signature and the receiver survives the wrapper.
 */
function forwardProviderMember<P extends Provider, K extends keyof P & string>(
	provider: P,
	property: K,
): P[K] {
	const member = provider[property];
	if (typeof member !== "function") {return member;}
	const bound = member.bind(provider) as P[K];
	return bound;
}
