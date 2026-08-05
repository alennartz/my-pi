import type { ProviderConfig } from "@earendil-works/pi-coding-agent";

/** The result of evaluating quota immediately before a provider request. */
export type QuotaGateResult =
	| { blocked: false }
	| { blocked: true; kind: "soft" | "hard"; message: string }
	| undefined;

export type ProviderStreamSimple = NonNullable<ProviderConfig["streamSimple"]>;

/**
 * Wrap a provider stream so quota enforcement happens before the underlying
 * provider is invoked. This is deliberately below session/input handling:
 * custom extension messages, tool-loop continuations, retries, and compaction
 * can all start a provider request without emitting an `input` event.
 */
export function guardStreamSimple(
	fallback: ProviderStreamSimple,
	evaluate: () => QuotaGateResult,
): ProviderStreamSimple {
	return (model, context, options) => {
		const decision = evaluate();
		if (decision?.blocked) throw new Error(decision.message);
		return fallback(model, context, options);
	};
}
