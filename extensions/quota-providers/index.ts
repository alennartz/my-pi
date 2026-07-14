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
import { readBypass, isBypassActive } from "./lib/bypass.js";
import { evaluateQuota } from "./lib/quota.js";
import { decideBlock } from "./lib/enforce.js";

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

export let providerRecords: readonly ProviderRecord[] = [];

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
					{ stdio: "ignore", timeout: 35_000 },
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(`quota-providers: skipping "${id}" — discovery failed: ${msg}`);
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

		// Quoted for /bin/sh -c; paths may contain spaces.
		const apiKeyCmd = `!"${process.execPath}" "${runnerPath}" token --module "${implPath}" --impl "${id}" --config "${configPath}" --cache "${paths.token}"`;

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

	providerRecords = Object.freeze(records);

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
	});

	// Append ledger entries after each assistant message and maybe refresh usage.
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		const record = providerIdToRecord.get(event.message.provider ?? "");
		if (!record) return;
		appendLedgerEntry(record.paths.ledger, {
			timestamp: event.message.timestamp,
			cost: event.message.usage?.cost?.total ?? 0,
		});
		maybeRefreshUsage(record);
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

		const ledger = readLedger(record.paths.ledger);
		const verdict = evaluateQuota(cached.snapshot, ledger, record.policy, Date.now());

		const bypassEntries = readBypass(record.paths.bypass);
		const bypassActive = isBypassActive(bypassEntries, process.env.PI_QUOTA_SCOPE ?? "");

		const decision = decideBlock({ verdict, policy: record.policy, bypassActive });
		if (!decision.blocked) return;

		if (ctx.hasUI) {
			ctx.ui.notify(decision.message, "error");
		} else {
			console.error(decision.message);
		}
		return { action: "handled" };
	});
}
