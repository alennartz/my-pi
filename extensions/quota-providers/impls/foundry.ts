/**
 * Azure Foundry implementation module for the quota-providers framework.
 *
 * Local (in-repo) port of the standalone `extensions/azure-foundry` extension.
 * Supplies raw facts through the three seams; the quota-providers core owns all
 * caching, token margins, background refresh, and (when a getUsage seam exists)
 * quota enforcement.
 *
 * This module deliberately omits `getUsage`, so Foundry opts OUT of the cost /
 * quota-enforcement feature — discovery + auth only, matching the old extension.
 *
 * Loaded two ways by the framework:
 *   - by the extension on pi's main path (jiti) to read `baseUrl`/`name`/
 *     `authHeader` for registration — no ctx available there, so `baseUrl` is
 *     resolved from the environment at load;
 *   - by runner.mjs (out-of-band) for `discoverModels`/`getToken`, where
 *     ctx.settings carries account / resourceGroup / subscription / tokenResource.
 */

import { execFileSync } from "node:child_process";
import type {
	ImplContext,
	ModelEntry,
	ProviderImplementation,
	TokenResult,
} from "../lib/types.js";

// =============================================================================
// Settings (from the config block, minus policy keys)
// =============================================================================

interface FoundrySettings {
	account: string; // Cognitive Services account name
	resourceGroup: string; // Azure resource group
	subscription?: string; // optional subscription name/id
	tokenResource?: string; // AAD audience; default below
}

const DEFAULT_TOKEN_RESOURCE = "https://cognitiveservices.azure.com";

function readSettings(ctx: ImplContext): FoundrySettings {
	const s = ctx.settings as Record<string, unknown>;
	const account = String(s.account ?? "");
	const resourceGroup = String(s.resourceGroup ?? "");
	if (!account || !resourceGroup) {
		throw new Error("foundry impl: account and resourceGroup are required in config");
	}
	return {
		account,
		resourceGroup,
		subscription: s.subscription ? String(s.subscription) : undefined,
		tokenResource: s.tokenResource ? String(s.tokenResource) : undefined,
	};
}

/** `az` with no shell — avoids injection via account/rg/subscription strings. */
function az(args: string[], timeoutMs: number): string {
	return execFileSync("az", args, { encoding: "utf-8", timeout: timeoutMs });
}

/**
 * Foundry deployment format/capabilities → pi api + pi-ai catalog provider +
 * base path + authHeader. Ported from foundry-helper.mjs `resolveBackend` and
 * index.ts BACKENDS / PI_AI_PROVIDER.
 */
function mapBackend(
	format: string | undefined,
	caps: Record<string, string>,
): Pick<ModelEntry, "api" | "catalogProvider" | "baseUrlPath" | "authHeader"> | null {
	if (format === "Anthropic") {
		return {
			// Azure Foundry rejects x-api-key-only for Anthropic, so force the
			// Authorization: Bearer header.
			api: "anthropic-messages",
			catalogProvider: "anthropic",
			baseUrlPath: "/anthropic",
			authHeader: true,
		};
	}
	if (format === "OpenAI") {
		if (caps.responses === "true") {
			return {
				api: "openai-responses",
				catalogProvider: "azure-openai-responses",
				baseUrlPath: "/openai/v1",
				authHeader: false,
			};
		}
		if (caps.chatCompletion === "true") {
			return {
				api: "openai-completions",
				catalogProvider: "azure-openai-responses",
				baseUrlPath: "/openai/v1",
				authHeader: false,
			};
		}
	}
	return null; // embeddings / non-chat / unknown
}

// =============================================================================
// Implementation
// =============================================================================

const impl: ProviderImplementation = {
	id: "foundry",
	name: "Azure Foundry",

	// Read once at registration (no ctx on that path). The endpoint is not
	// secret and the standalone extension already depends on this env var.
	baseUrl: (process.env.AZURE_FOUNDRY_ENDPOINT ?? "").replace(/\/+$/, ""),

	async discoverModels(ctx: ImplContext): Promise<ModelEntry[]> {
		const { account, resourceGroup, subscription } = readSettings(ctx);
		const args = [
			"cognitiveservices",
			"account",
			"deployment",
			"list",
			"-n",
			account,
			"-g",
			resourceGroup,
		];
		if (subscription) args.push("--subscription", subscription);
		args.push("-o", "json");

		const items = JSON.parse(az(args, 30_000)) as Array<Record<string, any>>;
		const models: ModelEntry[] = [];
		for (const item of items) {
			const props = item?.properties ?? {};
			if (props.provisioningState !== "Succeeded") continue;
			const mapped = mapBackend(props.model?.format, props.capabilities ?? {});
			if (!mapped) continue;
			models.push({
				id: item.name, // deployment name → sent to the API
				modelName: props.model?.name, // catalog key for metadata lookup
				...mapped,
			});
		}
		return models;
	},

	async getToken(ctx: ImplContext): Promise<TokenResult> {
		const { tokenResource } = readSettings(ctx);
		const resource = tokenResource ?? DEFAULT_TOKEN_RESOURCE;
		const raw = az(
			["account", "get-access-token", "--resource", resource, "-o", "json"],
			15_000,
		).trim();
		const parsed = JSON.parse(raw) as { accessToken?: string; expiresOn?: string };
		if (!parsed.accessToken) {
			throw new Error("foundry impl: az returned no accessToken — is `az login` valid?");
		}
		const expiresAt = new Date(parsed.expiresOn ?? "").getTime();
		if (Number.isNaN(expiresAt)) {
			throw new Error(`foundry impl: could not parse expiresOn: "${parsed.expiresOn}"`);
		}
		return { token: parsed.accessToken, expiresAt };
	},

	// getUsage intentionally omitted → no quota enforcement for Foundry.
};

export default impl;
