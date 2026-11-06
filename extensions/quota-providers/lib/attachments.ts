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
	_raw: string,
	_expandHome: (path: string) => string,
): ParsedQuotaAttachments {
	throw new Error("not implemented");
}

/** Load and parse the configured quota attachment file. */
export function loadQuotaAttachments(_path?: string): ParsedQuotaAttachments {
	throw new Error("not implemented");
}
