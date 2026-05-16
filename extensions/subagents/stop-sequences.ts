/**
 * Per-request stop sequence injection via before_provider_request.
 *
 * Provides addOnce() for one-shot sequences (auto-cleared after the next
 * LLM request) and add()/remove() for persistent sequences. Handles the
 * provider API differences internally.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

		return applyStopSequences(event.payload as any, model.api, sequences);
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

export function applyStopSequences(payload: any, api: string, sequences: string[]): any {
	switch (api) {
		// Anthropic
		case "anthropic-messages":
			payload.stop_sequences = mergeUnique(payload.stop_sequences, sequences);
			break;

		// OpenAI chat-completions style APIs support top-level `stop`
		case "openai-completions":
		case "mistral-conversations":
			payload.stop = mergeUnique(payload.stop, sequences);
			break;

		// OpenAI Responses-family APIs reject top-level `stop`.
		// Emulate the guard with a one-shot instruction instead.
		case "openai-responses":
		case "azure-openai-responses":
		case "openai-codex-responses":
			payload.instructions = appendStopInstruction(payload.instructions, sequences);
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

		default:
			// Unknown API — try the OpenAI-style `stop` field as a best guess.
			payload.stop = mergeUnique(payload.stop, sequences);
			break;
	}

	return payload;
}

function appendStopInstruction(existing: string | null | undefined, sequences: string[]): string {
	const markers = sequences.map((s) => `- ${s}`).join("\n");
	const instruction = [
		"System-delivered notification markers (not assistant output):",
		markers,
		"Do not emit, echo, simulate, or continue with any of those markers.",
		"If your next token would begin one of them, end your response immediately before emitting it.",
	].join("\n");
	return existing && existing.trim().length > 0 ? `${existing}\n\n${instruction}` : instruction;
}

function mergeUnique(existing: string[] | undefined, additions: string[]): string[] {
	if (!existing || existing.length === 0) return additions;
	const set = new Set(existing);
	for (const s of additions) set.add(s);
	return [...set];
}
