/**
 * Gemini xhigh thinking level on the native Google APIs.
 *
 * pi-ai's Google thinking-level map ends at high: a model whose
 * `thinkingLevelMap` names anything above it makes the resolver throw, and the
 * highest level that can reach the wire is HIGH. Gemini 4 models accept XHIGH,
 * so two pieces cooperate instead of patching pi:
 *
 * - `models.json` maps `xhigh` to `high` for those models, which satisfies the
 *   resolver and keeps level validation on pi's own path,
 * - this extension lifts the request back to XHIGH when the session runs at
 *   xhigh, so only xhigh sessions pay for xhigh reasoning.
 *
 * Every other level, API family, and payload shape passes through untouched.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** APIs that carry a Google thinking config. */
const GOOGLE_APIS = new Set(["google-generative-ai", "google-vertex", "google-gemini-cli"]);

/** A payload node that may own a `thinkingConfig`. */
type ThinkingConfigOwner = { thinkingConfig?: { thinkingLevel?: unknown } };

/**
 * Rewrite the wire level to XHIGH when the request runs at the xhigh session
 * level. Accepts both Google payload shapes: the SDK request keeps the config
 * under `config`, and REST-shaped payloads use `generationConfig`.
 */
export function applyXhighThinkingLevel(
	payload: unknown,
	api: string,
	thinkingLevel: string | undefined,
): unknown {
	if (thinkingLevel !== "xhigh" || !GOOGLE_APIS.has(api)) return payload;
	if (!payload || typeof payload !== "object") return payload;

	const request = payload as { config?: ThinkingConfigOwner; generationConfig?: ThinkingConfigOwner } & ThinkingConfigOwner;
	let changed = false;
	for (const owner of [request.config, request.generationConfig, request]) {
		const level = owner?.thinkingConfig?.thinkingLevel;
		if (level === "HIGH" || level === "high") {
			owner.thinkingConfig!.thinkingLevel = "XHIGH";
			changed = true;
		}
	}
	return changed ? request : payload;
}

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (!model) return;
		return applyXhighThinkingLevel(event.payload, model.api, ctx.thinkingLevel);
	});
}
