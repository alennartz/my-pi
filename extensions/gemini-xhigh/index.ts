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

import { isJsonObject } from "../subagents/narrow.js";
import type { JsonObject } from "../subagents/narrow.js";

/** APIs that carry a Google thinking config. */
const GOOGLE_APIS = new Set(["google-generative-ai", "google-vertex", "google-gemini-cli"]);

/**
 * Rewrite the wire level to XHIGH when the request runs at the xhigh session
 * level. Accepts both Google payload shapes: the SDK request keeps the config
 * under `config`, and REST-shaped payloads use `generationConfig`.
 */
export function applyXhighThinkingLevel(
	payload: JsonObject,
	api: string,
	thinkingLevel: string | undefined,
): JsonObject {
	if (thinkingLevel !== "xhigh" || !GOOGLE_APIS.has(api)) {return payload;}
	const owners: JsonObject[] = [payload];
	const config = isJsonObject(payload.config) ? payload.config : undefined;
	const generationConfig = isJsonObject(payload.generationConfig) ? payload.generationConfig : undefined;
	if (config !== undefined) {owners.push(config);}
	if (generationConfig !== undefined) {owners.push(generationConfig);}
	for (const owner of owners) {
		const thinkingConfig = isJsonObject(owner.thinkingConfig) ? owner.thinkingConfig : undefined;
		if (thinkingConfig === undefined) {continue;}
		const level = thinkingConfig.thinkingLevel;
		if (level === "HIGH" || level === "high") {thinkingConfig.thinkingLevel = "XHIGH";}
	}
	return payload;
}
