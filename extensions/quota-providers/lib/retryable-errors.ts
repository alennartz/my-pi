import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	createAssistantMessageEventStream,
	isContextOverflow,
	isRetryableAssistantError,
} from "@earendil-works/pi-ai";
import type { ProviderStreamSimple } from "./stream-guard.js";

// =============================================================================
// Retryable-error mapping
//
// pi classifies provider failures as retryable or not by pattern-matching the
// errorMessage text (pi-ai's isRetryableAssistantError) — there is no
// first-class retryable flag. An impl that knows its gateway's errors are
// transient says so via ProviderImplementation.isRetryableError; this module
// owns the single, deliberate hack that translates that verdict into pi's
// vocabulary: prefix the message with wording pi's classifier already treats
// as retryable.
// =============================================================================

/**
 * Wording matched by pi's existing `/provider.?returned.?error/i` retryable
 * pattern (pi-ai's RETRYABLE_PROVIDER_ERROR_PATTERN). It trips none of the
 * non-retryable patterns, which are checked first and win.
 */
export const RETRYABLE_ERROR_PREFIX = "Provider returned error (retryable): ";

/** Prefix `message` so pi's classifier treats it as retryable. Idempotent. */
export function makeRetryable(message: string): string {
	return message.startsWith(RETRYABLE_ERROR_PREFIX)
		? message
		: RETRYABLE_ERROR_PREFIX + message;
}

/**
 * Fail loudly instead of silently when the rewrite does not achieve
 * classification as retryable. Two known causes: the original text carries
 * non-retryable wording (quota/billing patterns win over anything prefixed), or
 * pi-ai changed its pattern lists across a version upgrade.
 */
function verifyClassifiesAsRetryable(errorMessage: string): void {
	const probe = { stopReason: "error", errorMessage } as AssistantMessage;
	if (isRetryableAssistantError(probe)) return;
	const why = isContextOverflow(probe)
		? "message classifies as context overflow (compaction path, not retry)"
		: "pi's non-retryable wording wins or pi-ai's pattern lists changed";
	console.warn(`quota-providers: retryable-error rewrite ineffective — ${why}: ${errorMessage}`);
}

/**
 * Wrap a provider stream so terminal error messages the impl classifies as
 * transient are rewritten into pi's retryable vocabulary. Aborts are never
 * touched; non-matching errors pass through unchanged.
 */
export function mapRetryableErrors(
	fallback: ProviderStreamSimple,
	isRetryable: (message: string) => boolean,
): ProviderStreamSimple {
	return (model, context, options) => {
		const source = fallback(model, context, options);
		const out = createAssistantMessageEventStream();

		const rewrite = (message: AssistantMessage): void => {
			const raw = message.errorMessage ?? "";
			if (raw.startsWith(RETRYABLE_ERROR_PREFIX)) return; // already rewritten
			let retryable = false;
			try {
				retryable = isRetryable(raw);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				console.warn(`quota-providers: isRetryableError threw — ${detail}`);
			}
			if (!retryable) return;
			const errorMessage = makeRetryable(raw);
			verifyClassifiesAsRetryable(errorMessage);
			message.errorMessage = errorMessage;
		};

		// Pump into a fresh stream: consumers may read `result()` instead of
		// iterating, so rewriting must happen before either path observes the
		// terminal message. The message object is shared with `partial`, so the
		// rewrite is visible to event consumers too.
		void (async () => {
			for await (const event of source) {
				if (event.type === "error" && event.reason === "error") rewrite(event.error);
				out.push(event);
			}
			const final = await source.result();
			if (final?.stopReason === "error") rewrite(final);
			out.end(final);
		})();

		return out;
	};
}
