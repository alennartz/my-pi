import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expandHome, POLICY_DEFAULTS, POLICY_KEYS, resolveAgentDir } from "./config.js";
import type { QuotaPolicy } from "./types.js";

/** A quota attachment keyed by an already-registered pi provider ID. */
export interface QuotaAttachment {
	providerId: string;
	modulePath: string;
	enabled: boolean;
	policy: QuotaPolicy;
	settings: Record<string, unknown>;
}

export interface ParsedQuotaAttachments {
	attachments: QuotaAttachment[];
	warnings: string[];
}

/** Parse quota-providers.json into provider attachments. */
export function parseQuotaAttachments(
	raw: string,
	expandHomePath: (path: string) => string,
): ParsedQuotaAttachments {
	const warnings: string[] = [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		warnings.push(`quota-providers: failed to parse config JSON: ${msg}`);
		return { attachments: [], warnings };
	}

	if (
		typeof parsed !== "object" ||
		parsed === null ||
		typeof (parsed as Record<string, unknown>).providers !== "object" ||
		(parsed as Record<string, unknown>).providers === null ||
		Array.isArray((parsed as Record<string, unknown>).providers)
	) {
		warnings.push('quota-providers: config must have a "providers" object at top level');
		return { attachments: [], warnings };
	}

	const rawProviders = (parsed as Record<string, unknown>).providers as Record<string, unknown>;
	const attachments: QuotaAttachment[] = [];
	const policyKeySet = new Set<string>(POLICY_KEYS);

	for (const [providerId, block] of Object.entries(rawProviders)) {
		if (typeof block !== "object" || block === null || Array.isArray(block)) {
			warnings.push(`quota-providers: provider "${providerId}" is not an object — skipping`);
			continue;
		}

		const entry = block as Record<string, unknown>;
		if (typeof entry.module !== "string" || entry.module === "") {
			warnings.push(
				`quota-providers: provider "${providerId}" has missing or non-string "module" — skipping`,
			);
			continue;
		}

		const policy: QuotaPolicy = {
			bypassAllowed:
				typeof entry.bypassAllowed === "boolean"
					? entry.bypassAllowed
					: POLICY_DEFAULTS.bypassAllowed,
			lookaheadHours:
				typeof entry.lookaheadHours === "number"
					? entry.lookaheadHours
					: POLICY_DEFAULTS.lookaheadHours,
			maxPollSeconds:
				typeof entry.maxPollSeconds === "number"
					? entry.maxPollSeconds
					: POLICY_DEFAULTS.maxPollSeconds,
			enforceHardCap:
				typeof entry.enforceHardCap === "boolean"
					? entry.enforceHardCap
					: POLICY_DEFAULTS.enforceHardCap,
		};

		const settings: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(entry)) {
			if (!policyKeySet.has(key)) settings[key] = value;
		}

		attachments.push({
			providerId,
			modulePath: expandHomePath(entry.module),
			enabled: entry.enabled !== false,
			policy,
			settings,
		});
	}

	return { attachments, warnings };
}

/** Load and parse the configured quota attachment file. */
export function loadQuotaAttachments(path?: string): ParsedQuotaAttachments {
	const configPath = path ?? join(resolveAgentDir(), "quota-providers.json");
	if (!existsSync(configPath)) return { attachments: [], warnings: [] };

	return parseQuotaAttachments(readFileSync(configPath, "utf-8"), expandHome);
}
