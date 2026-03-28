/**
 * Per-request stop sequence injection via before_provider_request.
 *
 * Provides addOnce() for one-shot sequences (auto-cleared after the next
 * LLM request) and add()/remove() for persistent sequences. Handles the
 * provider API differences internally.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export interface StopSequenceManager {
	/** Add sequences that persist until explicitly removed. */
	add(...sequences: string[]): void;
	/** Remove persistent sequences. */
	remove(...sequences: string[]): void;
	/** Add sequences for exactly the next LLM request, then auto-clear. */
	addOnce(...sequences: string[]): void;
	/** Remove all persistent and one-shot sequences. */
	clear(): void;
}

export function createStopSequenceManager(pi: ExtensionAPI): StopSequenceManager {
	const persistent = new Set<string>();
	let oneShot: string[] = [];

	pi.on("before_provider_request", (event, ctx) => {
		// Collect active sequences and drain one-shots
		const sequences = [...persistent, ...oneShot];
		oneShot = [];
		if (sequences.length === 0) return;

		const model = ctx.model;
		if (!model) return;

		const payload = event.payload as any;

		switch (model.api) {
			// Anthropic
			case "anthropic-messages":
				payload.stop_sequences = mergeUnique(payload.stop_sequences, sequences);
				break;

			// OpenAI family
			case "openai-completions":
			case "openai-responses":
			case "azure-openai-responses":
			case "openai-codex-responses":
				payload.stop = mergeUnique(payload.stop, sequences);
				break;

			// Google family
			case "google-generative-ai":
			case "google-vertex":
			case "google-gemini-cli":
				payload.generationConfig ??= {};
				payload.generationConfig.stopSequences = mergeUnique(
					payload.generationConfig.stopSequences,
					sequences,
				);
				break;

			// Bedrock (Anthropic-style under the hood)
			case "bedrock-converse-stream":
				payload.additionalModelRequestFields ??= {};
				payload.additionalModelRequestFields.stop_sequences = mergeUnique(
					payload.additionalModelRequestFields.stop_sequences,
					sequences,
				);
				break;

			// Mistral
			case "mistral-conversations":
				payload.stop = mergeUnique(payload.stop, sequences);
				break;

			default:
				// Unknown API — try the OpenAI-style "stop" field as a best guess
				payload.stop = mergeUnique(payload.stop, sequences);
				break;
		}

		return payload;
	});

	return {
		add(...sequences) {
			for (const s of sequences) persistent.add(s);
		},
		remove(...sequences) {
			for (const s of sequences) persistent.delete(s);
		},
		addOnce(...sequences) {
			oneShot.push(...sequences);
		},
		clear() {
			persistent.clear();
			oneShot = [];
		},
	};
}

function mergeUnique(existing: string[] | undefined, additions: string[]): string[] {
	if (!existing || existing.length === 0) return additions;
	const set = new Set(existing);
	for (const s of additions) set.add(s);
	return [...set];
}
