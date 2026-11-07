/**
 * Quota-aware provider extension.
 *
 * Quota attachments name providers that already exist in pi's model registry.
 * The extension wraps those complete providers at session start and keeps all
 * usage polling and quota state outside the provider transport.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Provider, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { loadQuotaAttachments } from "./lib/attachments.js";
import { readBypass, writeBypass, resolveRequestStore } from "./lib/bypass.js";
import { cachePaths, resolveAgentDir } from "./lib/config.js";
import { decideBlock } from "./lib/enforce.js";
import { appendLedgerEntry, readLedger } from "./lib/ledger.js";
import { wrapProviderWithQuota } from "./lib/provider-wrapper.js";
import { applicableSnapshots, effectiveSpend, evaluateQuota, firstHitSnapshot } from "./lib/quota.js";
import { readUsageCache } from "./lib/usage-cache.js";
import type { CachePaths } from "./lib/config.js";
import type { QuotaPolicy, QuotaSource } from "./lib/types.js";
import {
	getOrCreateSessionTreeStore,
	registerSessionIdTreeStore,
	unregisterSessionIdTreeStore,
} from "../subagents/scoped-store.js";
import type { SessionTreeStore } from "../../lib/session-tree-store.js";

export interface ProviderRecord {
	/** The pi provider ID named by the quota attachment. */
	id: string;
	modulePath: string;
	configPath: string;
	paths: CachePaths;
	policy: QuotaPolicy;
	hasUsageSeam: true;
}

type QuotaRecordFacts = Pick<ProviderRecord, "paths" | "policy" | "hasUsageSeam">;

/**
 * Evaluate every active limit that applies to the selected model.
 * An absent result means that no complete usage cache exists yet.
 */
function evaluateProviderQuota(
	record: QuotaRecordFacts,
	store: SessionTreeStore | undefined,
	now = Date.now(),
	modelId?: string,
): ReturnType<typeof decideBlock> | undefined {
	if (!record.hasUsageSeam) return undefined;
	const cached = readUsageCache(record.paths.usage);
	if (!cached) return undefined;
	const limitIds = modelId
		? cached.modelLimitIds[modelId] ?? []
		: [];
	const snapshots = applicableSnapshots(cached.snapshots, limitIds, now)
		.sort((a, b) => a.windowEnd - b.windowEnd);
	if (snapshots.length === 0) return undefined;

	const ledger = readLedger(record.paths.ledger);
	const bypassActive = record.policy.bypassAllowed && store ? readBypass(store) : false;
	const decisions = snapshots.map((snapshot) => {
		const decision = decideBlock({
			verdict: evaluateQuota(snapshot, ledger, record.policy, now),
			policy: record.policy,
			bypassActive,
		});
		return decision.blocked && snapshot.label
			? { ...decision, message: `${snapshot.label}: ${decision.message}` }
			: decision;
	});

	return decisions.find((decision) => decision.blocked && decision.kind === "hard") ??
		decisions.find((decision) => decision.blocked) ??
		{ blocked: false };
}

function formatDollars(amount: number): string {
	return `$${amount % 1 === 0 ? amount.toFixed(0) : amount.toFixed(2)}`;
}

function formatShortDate(ms: number): string {
	return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Days ahead of/behind budget: one decimal below 10d, whole beyond. */
function formatDaysAhead(days: number): string {
	const magnitude = Math.abs(days);
	const text = magnitude < 10
		? magnitude.toFixed(1).replace(/\.0$/, "")
		: String(Math.round(magnitude));
	return `${days < 0 ? "-" : "+"}${text}d`;
}

/** Build the compact footer line for the active model. */
function buildFooterLine(
	record: ProviderRecord,
	now: number,
	store: SessionTreeStore,
	modelId?: string,
): string | undefined {
	if (!record.hasUsageSeam) return undefined;
	const cached = readUsageCache(record.paths.usage);
	if (!cached) return undefined;

	const ledger = readLedger(record.paths.ledger);
	const bypassActive = record.policy.bypassAllowed && readBypass(store);
	const limitIds = modelId ? cached.modelLimitIds[modelId] ?? [] : [];
	const snapshot = firstHitSnapshot(cached.snapshots, limitIds, ledger, now);
	if (!snapshot) return undefined;

	const verdict = evaluateQuota(snapshot, ledger, record.policy, now);
	const spend = effectiveSpend(snapshot, ledger);
	const delta = formatDaysAhead(verdict.daysAhead);
	const resetDate = formatShortDate(verdict.resetAt);

	let suffix = "";
	if (verdict.state === "hard-exceeded") suffix = " · HARD CAP";
	else if (bypassActive) suffix = " · bypassed";
	else if (verdict.state === "soft-exceeded") suffix = " · soft cap";

	return `quota: ${formatDollars(spend)}/${formatDollars(snapshot.quota)} ${delta}→${resetDate}${suffix}`;
}

/** Push (or clear) the quota statusline. */
export function refreshStatusline(
	record: ProviderRecord | null | undefined,
	ctx: ExtensionContext,
): void {
	if (!ctx.hasUI || typeof ctx.ui?.setStatus !== "function") return;
	const store = getOrCreateSessionTreeStore(ctx.sessionManager);
	const line = record ? buildFooterLine(record, Date.now(), store, ctx.model?.id) : undefined;
	ctx.ui.setStatus("quota-providers", line);
}

/** Load and validate a quota-source module. */
async function loadQuotaSource(modulePath: string): Promise<QuotaSource> {
	const { createJiti } = await import("jiti");
	const jiti = createJiti(import.meta.url, { interopDefault: true });
	const loaded = await jiti.import(modulePath) as unknown;
	const source = loaded && typeof loaded === "object" && "getUsage" in loaded
		? loaded
		: loaded && typeof loaded === "object" && "default" in loaded
			? (loaded as { default?: unknown }).default
			: undefined;
	if (!source || typeof source !== "object" || typeof (source as { getUsage?: unknown }).getUsage !== "function") {
		throw new Error("module does not export a quota source with getUsage()");
	}
	return source as QuotaSource;
}

/** Fire-and-forget usage poll. */
function spawnUsageRefresh(record: RecordWithRunner): void {
	try {
		const child = spawn(process.execPath, [
			record.runnerPath,
			"usage",
			"--module", record.modulePath,
			"--impl", record.id,
			"--config", record.configPath,
			"--cache", record.paths.usage,
			"--ledger", record.paths.ledger,
			"--max-poll-seconds", String(record.policy.maxPollSeconds),
		], { detached: true, stdio: "ignore" });
		child.unref();
	} catch {
		// Usage polling is best effort. The cached snapshot remains authoritative.
	}
}

// `runnerPath` is fixed for the extension lifetime. Keeping it on each record
// makes the detached poll operation explicit and avoids another mutable lookup.
type RecordWithRunner = ProviderRecord & { runnerPath: string };

/** Poll when no usable cache exists, when it is old, or after a window reset. */
function maybeRefreshUsage(record: RecordWithRunner): void {
	const cached = readUsageCache(record.paths.usage);
	const now = Date.now();
	const windowEnded = cached?.snapshots.some((snapshot) => now >= snapshot.windowEnd) ?? false;
	const age = cached ? (now - cached.writtenAt) / 1000 : Infinity;
	if (!windowEnded && age < record.policy.maxPollSeconds) return;
	spawnUsageRefresh(record);
}

export default async function quotaProvidersExtension(pi: ExtensionAPI): Promise<void> {
	const agentDir = resolveAgentDir();
	const configPath = join(agentDir, "quota-providers.json");
	const runnerPath = fileURLToPath(new URL("./runner.mjs", import.meta.url));
	const { attachments, warnings } = loadQuotaAttachments(configPath);
	for (const warning of warnings) console.warn(warning);

	const records: RecordWithRunner[] = [];
	for (const attachment of attachments) {
		if (!attachment.enabled) continue;
		try {
			await loadQuotaSource(attachment.modulePath);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(
				`quota-providers: skipping "${attachment.providerId}" — failed to load quota source: ${message}`,
			);
			continue;
		}
		const record: RecordWithRunner = Object.freeze({
			id: attachment.providerId,
			modulePath: attachment.modulePath,
			configPath,
			paths: cachePaths(agentDir, attachment.providerId),
			policy: attachment.policy,
			hasUsageSeam: true,
			runnerPath,
		});
		records.push(record);
	}
	const providerRecords = Object.freeze(records);
	const providerIdToRecord = new Map<string, RecordWithRunner>(
		records.map((record) => [record.id, record]),
	);
	const attachedProviderIds = new Set<string>();

	let treeStore: SessionTreeStore | undefined;
	let fallbackSessionId: string | undefined;
	const boundStores = new Map<string, SessionTreeStore>();

	const sessionIdOf = (manager: object): string | undefined =>
		(manager as { getSessionId?: () => string }).getSessionId?.call(manager);

	function bindTreeStore(ctx: { sessionManager: object }, preferFallback: boolean): void {
		const store = getOrCreateSessionTreeStore(ctx.sessionManager);
		treeStore = store;
		const sessionId = sessionIdOf(ctx.sessionManager);
		if (!sessionId) return;
		boundStores.set(sessionId, store);
		registerSessionIdTreeStore(sessionId, store);
		if (preferFallback || !fallbackSessionId) fallbackSessionId = sessionId;
	}

	function attachProviders(ctx: { modelRegistry: { getProvider(id: string): Provider | undefined } }): void {
		for (const record of providerRecords) {
			if (attachedProviderIds.has(record.id)) continue;
			const provider = ctx.modelRegistry.getProvider(record.id);
			if (!provider) continue;
			const evaluate = (model: Model<any>, options?: SimpleStreamOptions) => evaluateProviderQuota(
					record,
					resolveRequestStore(options?.sessionId, treeStore),
					Date.now(),
					model.id,
				);
			const wrapped = wrapProviderWithQuota(provider, evaluate);
			pi.registerProvider(wrapped);

			// A models.json provider is recomposed by pi after native registration.
			// Patch that effective object so its lazy composer cannot swallow a
			// synchronous quota block into an ordinary transport error stream.
			const effective = ctx.modelRegistry.getProvider(record.id);
			if (effective && effective !== wrapped) {
				const effectiveWrapped = wrapProviderWithQuota(effective, evaluate);
				if (effectiveWrapped !== effective) {
					try {
						Object.defineProperty(effective, "streamSimple", {
							configurable: true,
							enumerable: true,
							writable: true,
							value: effectiveWrapped.streamSimple,
						});
					} catch {
						// Providers with an immutable stream method retain their native
						// registration and cannot be patched in place.
					}
				}
			}
			attachedProviderIds.add(record.id);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		bindTreeStore(ctx, true);
		attachProviders(ctx);
		const record = providerIdToRecord.get(ctx.model?.provider ?? "");
		if (record) maybeRefreshUsage(record);
		refreshStatusline(record, ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		bindTreeStore(ctx, false);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const sessionId = sessionIdOf(ctx.sessionManager);
		if (!sessionId) return;
		const store = boundStores.get(sessionId);
		unregisterSessionIdTreeStore(sessionId, store);
		boundStores.delete(sessionId);
		if (fallbackSessionId === sessionId) {
			fallbackSessionId = undefined;
			treeStore = undefined;
		}
	});

	pi.on("model_select", (event, ctx) => {
		const record = providerIdToRecord.get(event.model.provider ?? "");
		if (record) maybeRefreshUsage(record);
		refreshStatusline(record, ctx);
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const record = providerIdToRecord.get(event.message.provider ?? "");
		if (!record) return;

		const cached = readUsageCache(record.paths.usage);
		const quotaLimitIds = cached?.modelLimitIds[event.message.model];
		appendLedgerEntry(
			record.paths.ledger,
			{
				timestamp: event.message.timestamp,
				cost: event.message.usage?.cost?.total ?? 0,
				...(quotaLimitIds ? { quotaLimitIds } : {}),
			},
			`${record.paths.ledger}.lock`,
		);
		maybeRefreshUsage(record);
		refreshStatusline(providerIdToRecord.get(ctx.model?.provider ?? ""), ctx);
	});

	pi.on("input", (_event, ctx) => {
		const record = providerIdToRecord.get(ctx.model?.provider ?? "");
		if (!record) return;
		maybeRefreshUsage(record);
		refreshStatusline(record, ctx);
	});

	pi.registerCommand("quota", {
		description: "Show quota status or toggle bypass (/quota bypass [on|off])",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);

			if (parts[0] === "bypass") {
				const allowed = providerRecords.filter((record) => record.policy.bypassAllowed);
				if (providerRecords.length === 0) {
					ctx.ui.notify("No quota providers configured — quota bypass is unavailable.", "warning");
					return;
				}
				if (allowed.length === 0) {
					ctx.ui.notify(
						"Bypass is disabled for all managed providers (bypassAllowed: false in config).",
						"warning",
					);
					return;
				}

				const store = treeStore ?? getOrCreateSessionTreeStore(ctx.sessionManager);
				const subcommand = parts[1];
				const shouldEnable = subcommand === "on"
					? true
					: subcommand === "off"
						? false
						: !readBypass(store);
				writeBypass(store, shouldEnable);
				ctx.ui.notify(`Quota bypass turned ${shouldEnable ? "on" : "off"}.`);
				refreshStatusline(providerIdToRecord.get(ctx.model?.provider ?? ""), ctx);
				return;
			}

			if (providerRecords.length === 0) {
				ctx.ui.notify("No quota providers configured.");
				return;
			}
			const record = providerIdToRecord.get(ctx.model?.provider ?? "");
			if (!record) {
				ctx.ui.notify("Current model's provider isn't quota-tracked.");
				return;
			}
			maybeRefreshUsage(record);
			const store = treeStore ?? getOrCreateSessionTreeStore(ctx.sessionManager);
			const line = buildFooterLine(record, Date.now(), store, ctx.model?.id);
			if (!line) {
				ctx.ui.notify(`${record.id}: no quota data yet.`);
				return;
			}
			refreshStatusline(record, ctx);
			ctx.ui.notify(line);
		},
	});
}
