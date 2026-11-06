/** Fake quota source used by runner integration tests. */

import type { ImplContext, QuotaSource, QuotaSourceResult, UsageSnapshot } from "../lib/types.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

function failSeamsIncludes(context: ImplContext, seam: string): boolean {
	const list = context.settings.failSeams;
	return Array.isArray(list) && list.includes(seam);
}

function incrementCounter(path: string | undefined): void {
	if (!path) return;
	let count = 0;
	if (existsSync(path)) {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			if (typeof parsed?.count === "number") count = parsed.count;
		} catch {
			// Corrupt counters start from zero.
		}
	}
	writeFileSync(path, JSON.stringify({ count: count + 1 }), "utf8");
}

function configuredUsage(value: unknown, modelLimitIds: unknown): QuotaSourceResult {
	if (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Array.isArray((value as { snapshots?: unknown }).snapshots)
	) {
		const result = value as Partial<QuotaSourceResult>;
		return {
			snapshots: result.snapshots as UsageSnapshot[],
			modelLimitIds: (result.modelLimitIds as Record<string, string[]> | undefined) ?? {},
		};
	}
	return {
		snapshots: (Array.isArray(value) ? value : [value]) as UsageSnapshot[],
		modelLimitIds: (modelLimitIds as Record<string, string[]> | undefined) ?? {},
	};
}

const fakeSource: QuotaSource = {
	async getUsage(context: ImplContext): Promise<QuotaSourceResult> {
		if (failSeamsIncludes(context, "usage") || !context.settings.usage) {
			throw new Error("fake: getUsage seam failure (failSeams includes 'usage' or usage absent)");
		}
		incrementCounter(context.settings.counterFile as string | undefined);
		return configuredUsage(context.settings.usage, context.settings.modelLimitIds);
	},
};

export default fakeSource;
