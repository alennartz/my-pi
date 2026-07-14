/**
 * Quota-aware Provider Extension
 *
 * Registers provider implementations declared in ~/.pi/agent/quota-providers.json.
 * Each implementation is an out-of-repo TypeScript module that satisfies
 * ProviderImplementation (lib/types.ts). Discovery and token fetch are delegated
 * to the out-of-band runner (runner.mjs) so neither blocks the extension-factory
 * path.
 */

import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadProvidersConfig, cachePaths, resolveAgentDir } from "./lib/config.js";
import type { CachePaths } from "./lib/config.js";
import {
	readModelsCache,
	groupModels,
	buildProviderConfig,
	discoveryRefreshDue,
} from "./lib/registration.js";
import type { ProviderImplementation, QuotaPolicy } from "./lib/types.js";
import { appendLedgerEntry, readLedger } from "./lib/ledger.js";
import { readUsageSnapshot } from "./lib/snapshot.js";
import { readBypass, writeBypass, isBypassActive, pruneBypass } from "./lib/bypass.js";
import { evaluateQuota, effectiveSpend } from "./lib/quota.js";
import { decideBlock } from "./lib/enforce.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// =============================================================================
// Module-level state — init-then-freeze; consumed by Steps 10–13.
// =============================================================================

export interface ProviderRecord {
	id: string;
	implPath: string;
	configPath: string;
	paths: CachePaths;
	policy: QuotaPolicy;
	hasUsageSeam: boolean;
	providerIds: string[];
}

// =============================================================================
// Pure helpers
// =============================================================================

function formatDollars(amount: number): string {
	return `$${amount.toFixed(2)}`;
}

function formatDaysAhead(days: number): string {
	if (days < 0) {
		return `under budget by ${Math.abs(days).toFixed(1)} days`;
	}
	const date = new Date(Date.now() + days * 86_400_000).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
	});
	return `spending at ${date}'s budget`;
}

/**
 * Recompute and push the footer statusline for the worst-offending provider.
 * Worst offending = highest daysAhead across providers with a usage snapshot.
 * Pass providerRecords explicitly (pure function — no global capture of mutable state).
 */
function refreshStatusline(records: readonly ProviderRecord[], ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;

	let worstRecord: ProviderRecord | null = null;
	let worstDaysAhead = -Infinity;

	for (const record of records) {
		if (!record.hasUsageSeam) continue;
		const cached = readUsageSnapshot(record.paths.usage);
		if (!cached) continue;
		const ledger = readLedger(record.paths.ledger);
		const verdict = evaluateQuota(cached.snapshot, ledger, record.policy, Date.now());
		if (verdict.daysAhead > worstDaysAhead) {
			worstDaysAhead = verdict.daysAhead;
			worstRecord = record;
		}
	}

	if (!worstRecord) {
		ctx.ui.setStatus("quota-providers", undefined);
		return;
	}

	const cached = readUsageSnapshot(worstRecord.paths.usage);
	if (!cached) {
		ctx.ui.setStatus("quota-providers", undefined);
		return;
	}

	const now = Date.now();
	const ledger = readLedger(worstRecord.paths.ledger);
	const verdict = evaluateQuota(cached.snapshot, ledger, worstRecord.policy, now);
	const windowLengthMs = cached.snapshot.windowEnd - cached.snapshot.windowStart;
	const rawBypass = readBypass(worstRecord.paths.bypass);
	const bypassEntries = pruneBypass(rawBypass, now, windowLengthMs);
	const bypassActive = isBypassActive(bypassEntries, process.env.PI_QUOTA_SCOPE ?? "");

	// Hard cap takes precedence over bypass display — hard cap is never bypassable.
	let suffix = "";
	if (verdict.state === "hard-exceeded") {
		suffix = " (HARD CAP)";
	} else if (bypassActive) {
		suffix = " (bypassed)";
	} else if (verdict.state === "soft-exceeded") {
		suffix = " (soft cap)";
	}

	const date = new Date(Date.now() + verdict.daysAhead * 86_400_000).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
	});
	ctx.ui.setStatus("quota-providers", `quota: spending at ${date}'s budget${suffix}`);
}

// =============================================================================
// Helpers
// =============================================================================

/** Fire-and-forget background discover; never blocks, never throws. */
function spawnRefreshDetached(args: string[]): void {
	try {
		const child = spawn(process.execPath, args, { detached: true, stdio: "ignore" });
		child.unref();
	} catch {
		// best-effort
	}
}

/** Load an implementation module via jiti (same mechanism as runner.mjs). */
async function loadImpl(modulePath: string): Promise<ProviderImplementation> {
	const { createJiti } = await import("jiti");
	const jiti = createJiti(import.meta.url, { interopDefault: true });
	return jiti.import(modulePath) as Promise<ProviderImplementation>;
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default async function (pi: ExtensionAPI) {
	// Distinguish process cold start from /new or /reload within the same process.
	// jiti loads extensions with moduleCache:false, so module scope is wiped on
	// every factory re-run — a globalThis sentinel survives re-imports within one
	// process but is fresh in every new process.
	const SENTINEL = Symbol.for("quota-providers/process-seen");
	const g = globalThis as Record<symbol, unknown>;
	const firstRunInProcess = !g[SENTINEL];
	g[SENTINEL] = true;

	const { providers, warnings } = loadProvidersConfig();
	for (const w of warnings) console.warn(w);

	const agentDir = resolveAgentDir();
	const configPath = join(agentDir, "quota-providers.json");
	const runnerPath = fileURLToPath(new URL("./runner.mjs", import.meta.url));
	const now = Date.now();

	const records: ProviderRecord[] = [];

	for (const resolved of providers) {
		if (!resolved.enabled) continue;

		const { id, modulePath: implPath, policy } = resolved;
		const paths = cachePaths(agentDir, id);

		// Load the impl to get its top-level metadata (baseUrl, name, authHeader,
		// hasUsageSeam). The runner also loads it independently for each subcommand —
		// this is intentionally redundant: the factory needs the metadata synchronously
		// to call buildProviderConfig, and keeping impl loading out of the runner's
		// responsibility keeps both sides simple.
		let impl: ProviderImplementation;
		try {
			impl = await loadImpl(implPath);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`quota-providers: skipping "${id}" — failed to load impl module: ${msg}`);
			continue;
		}

		let cache = readModelsCache(paths.models);

		if (!cache) {
			// Cold cache miss: block once to populate it, then read it back.
			try {
				execFileSync(
					process.execPath,
					[
						runnerPath,
						"discover",
						"--module",
						implPath,
						"--impl",
						id,
						"--config",
						configPath,
						"--cache",
						paths.models,
					],
					{ stdio: ["ignore", "ignore", "pipe"], timeout: 35_000 },
				);
			} catch (err) {
				const runnerStderr =
					(err as NodeJS.ErrnoException & { stderr?: Buffer }).stderr?.toString()?.trim();
				const msg = err instanceof Error ? err.message : String(err);
				const detail = runnerStderr ? `\n  Runner output: ${runnerStderr}` : "";
				console.warn(`quota-providers: skipping "${id}" — discovery failed: ${msg}${detail}`);
				continue;
			}
			cache = readModelsCache(paths.models);
			if (!cache) {
				console.warn(`quota-providers: skipping "${id}" — discovery produced no cache`);
				continue;
			}
		} else {
			// Warm cache: maybe kick a detached background refresh for next time.
			//  - cold start: always, unless cache younger than the floor (absorbs
			//    bursts of process/subagent spawns).
			//  - /new or /reload: only when older than the TTL (don't spawn per /new).
			if (discoveryRefreshDue(cache.writtenAt, now, firstRunInProcess)) {
				spawnRefreshDetached([
					runnerPath,
					"discover",
					"--module",
					implPath,
					"--impl",
					id,
					"--config",
					configPath,
					"--cache",
					paths.models,
				]);
			}
		}

		const groups = groupModels(id, cache.models, impl.authHeader);

		// Single-quote escaping for /bin/sh -c — safe against $, backticks, and
		// embedded double quotes in paths. Replace ' with '\'' to embed a literal
		// single quote inside a single-quoted segment.
		const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}' `;
		// sq() adds a trailing space so each token is already separated.
		const apiKeyCmd = `!${sq(process.execPath)}${sq(runnerPath)}token --module ${sq(implPath)}--impl ${sq(id)}--config ${sq(configPath)}--cache ${sq(paths.token)}`.trimEnd();

		const implMeta = {
			id: impl.id,
			name: impl.name,
			baseUrl: impl.baseUrl,
			authHeader: impl.authHeader,
		};

		const providerIds: string[] = [];
		for (const group of groups) {
			pi.registerProvider(group.providerId, buildProviderConfig(implMeta, group, apiKeyCmd));
			providerIds.push(group.providerId);
		}

		records.push(
			Object.freeze({
				id,
				implPath,
				configPath,
				paths,
				policy,
				hasUsageSeam: typeof impl.getUsage === "function",
				providerIds,
			}),
		);
	}

	const providerRecords = Object.freeze(records);

	// Build provider-id → record lookup used by event handlers.
	const providerIdToRecord = new Map<string, ProviderRecord>();
	for (const record of records) {
		for (const pid of record.providerIds) {
			providerIdToRecord.set(pid, record);
		}
	}

	/** Kick a detached usage-poll if cache is stale; best-effort. */
	function maybeRefreshUsage(record: ProviderRecord): void {
		if (!record.hasUsageSeam) return;
		const cached = readUsageSnapshot(record.paths.usage);
		const age = cached ? (Date.now() - cached.writtenAt) / 1000 : Infinity;
		if (age < record.policy.maxPollSeconds) return;
		try {
			const child = spawn(process.execPath, [
				runnerPath, "usage",
				"--module", record.implPath,
				"--impl", record.id,
				"--config", configPath,
				"--cache", record.paths.usage,
				"--ledger", record.paths.ledger,
				"--max-poll-seconds", String(record.policy.maxPollSeconds),
			], { detached: true, stdio: "ignore" });
			child.unref();
		} catch { /* best-effort */ }
	}

	// Scope id: the root session id is inherited by child processes via
	// process.env, so all subagents spawned from the same root session share
	// the same quota scope without extra coordination.
	pi.on("session_start", (_event, ctx) => {
		if (!process.env.PI_QUOTA_SCOPE) {
			process.env.PI_QUOTA_SCOPE = ctx.sessionManager.getSessionId();
		}
		refreshStatusline(providerRecords, ctx);
	});

	// Append ledger entries after each assistant message and maybe refresh usage.
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const record = providerIdToRecord.get(event.message.provider ?? "");
		if (!record) return;
		appendLedgerEntry(record.paths.ledger, {
			timestamp: event.message.timestamp,
			cost: event.message.usage?.cost?.total ?? 0,
		});
		maybeRefreshUsage(record);
		refreshStatusline(providerRecords, ctx);
	});

	// Block new prompts when quota is exceeded.
	pi.on("input", (event, ctx) => {
		// Skip extension commands so /quota bypass on is reachable while blocked.
		if (event.text.startsWith("/")) return;

		const record = providerIdToRecord.get(ctx.model?.provider ?? "");
		if (!record || !record.hasUsageSeam) return;

		maybeRefreshUsage(record);

		const cached = readUsageSnapshot(record.paths.usage);
		if (!cached) return; // no data yet — never block on missing data

		const now = Date.now();
		const ledger = readLedger(record.paths.ledger);
		const verdict = evaluateQuota(cached.snapshot, ledger, record.policy, now);

		const windowLengthMs = cached.snapshot.windowEnd - cached.snapshot.windowStart;
		const rawBypass = readBypass(record.paths.bypass);
		const bypassEntries = pruneBypass(rawBypass, now, windowLengthMs);
		const bypassActive = isBypassActive(bypassEntries, process.env.PI_QUOTA_SCOPE ?? "");

		const decision = decideBlock({ verdict, policy: record.policy, bypassActive });

		refreshStatusline(providerRecords, ctx);

		if (!decision.blocked) return;

		if (ctx.hasUI) {
			ctx.ui.notify(decision.message, "error");
		} else {
			console.error(decision.message);
		}
		return { action: "handled" };
	});

	// =========================================================================
	// /quota command
	// =========================================================================

	pi.registerCommand("quota", {
		description: "Show quota status or toggle bypass (/quota bypass [on|off])",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);

			if (parts[0] === "bypass") {
				// bypass on / bypass off / bypass (toggle)
				const seamed = providerRecords.filter((r) => r.hasUsageSeam);
				if (seamed.length === 0) {
					ctx.ui.notify(
						"No providers with a usage seam configured — quota bypass is unavailable.",
						"warning",
					);
					return;
				}
				const allowed = seamed.filter((r) => r.policy.bypassAllowed);
				if (allowed.length === 0) {
					ctx.ui.notify(
						"Bypass is disabled for all managed providers (bypassAllowed: false in config).",
						"warning",
					);
					return;
				}

				const scopeId = process.env.PI_QUOTA_SCOPE ?? "";
				const subcommand = parts[1]; // "on", "off", or undefined (toggle)
				const now = Date.now();
				let newState: boolean | undefined;

				// For a bare toggle, compute the target state once from any-active
				// across all providers, so they all flip uniformly rather than each
				// independently inverting its own current state.
				const toggleTarget: boolean | undefined =
					subcommand === undefined
						? !allowed.some((r) => isBypassActive(readBypass(r.paths.bypass), scopeId))
						: undefined;

				for (const record of allowed) {
					const entries = readBypass(record.paths.bypass);
					const cached = readUsageSnapshot(record.paths.usage);
					const windowLengthMs =
						cached
							? cached.snapshot.windowEnd - cached.snapshot.windowStart
							: 30 * 24 * 3_600_000;

					const pruned = pruneBypass(entries, now, windowLengthMs);
					const shouldEnable =
						subcommand === "on" ? true : subcommand === "off" ? false : toggleTarget!;

					if (shouldEnable) {
						pruned[scopeId] = { enabledAt: now };
					} else {
						delete pruned[scopeId];
					}
					writeBypass(record.paths.bypass, pruned);
					newState = shouldEnable;
				}

				ctx.ui.notify(`Quota bypass turned ${newState ? "on" : "off"}.`);
				return;
			}

			// Status display (no args) — show all providers, not just those with a
			// usage seam, so the seam-present indicator is visible per provider.
			if (providerRecords.length === 0) {
				ctx.ui.notify("No quota providers configured.");
				return;
			}

			const scopeId = process.env.PI_QUOTA_SCOPE ?? "";
			const now = Date.now();
			const sections: string[] = [];

			for (const record of providerRecords) {
				const lines: string[] = [`Provider: ${record.id}`];
				lines.push(`  Usage seam: ${record.hasUsageSeam ? "yes" : "no"}`);

				if (!record.hasUsageSeam) {
					// No usage seam — quota enforcement unavailable for this provider.
					sections.push(lines.join("\n"));
					continue;
				}

				const cached = readUsageSnapshot(record.paths.usage);
				const ledger = readLedger(record.paths.ledger);
				const bypassEntries = readBypass(record.paths.bypass);
				const bypassActive = isBypassActive(bypassEntries, scopeId);

				if (!cached) {
					lines.push("  Spend / Quota: no data yet");
				} else {
					const verdict = evaluateQuota(cached.snapshot, ledger, record.policy, now);
					const spend = effectiveSpend(cached.snapshot, ledger);

					lines.push(
						`  Spend / Quota: ${formatDollars(spend)} / ${formatDollars(cached.snapshot.quota)}`,
					);
					const rawDays = verdict.daysAhead >= 0
						? `+${verdict.daysAhead.toFixed(1)}`
						: verdict.daysAhead.toFixed(1);
					lines.push(`  Pace: ${formatDaysAhead(verdict.daysAhead)} (${rawDays} days)`);

					const resetDate = new Date(verdict.resetAt).toLocaleDateString("en-US", {
						month: "short",
						day: "numeric",
						year: "numeric",
					});
					lines.push(`  Window resets: ${resetDate}`);

					const ageMs = now - cached.writtenAt;
					const ageStr =
						ageMs < 60_000
							? `${Math.round(ageMs / 1000)}s ago`
							: ageMs < 3_600_000
								? `${Math.round(ageMs / 60_000)}m ago`
								: `${Math.round(ageMs / 3_600_000)}h ago`;
					lines.push(`  Snapshot age: ${ageStr}`);
				}

				lines.push(`  Bypass: ${bypassActive ? "active" : "inactive"}`);
				sections.push(lines.join("\n"));
			}

			ctx.ui.notify(sections.join("\n\n"));
		},
	});
}
