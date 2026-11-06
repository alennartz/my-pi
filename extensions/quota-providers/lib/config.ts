import { join } from "node:path";
import { homedir } from "node:os";
import type { QuotaPolicy } from "./types.js";

// Policy keys — reserved in each provider config block.
// Everything else passes through as quota-source settings.

export const POLICY_KEYS = [
	"module",
	"enabled",
	"bypassAllowed",
	"lookaheadHours",
	"maxPollSeconds",
	"enforceHardCap",
] as const;

export const POLICY_DEFAULTS: QuotaPolicy = {
	bypassAllowed: true,
	lookaheadHours: 6,
	maxPollSeconds: 300,
	enforceHardCap: false,
};

/** Resolve the pi agent directory used by quota configuration and caches. */
export function resolveAgentDir(): string {
	const env = process.env.PI_CODING_AGENT_DIR;
	if (env) return env.startsWith("~/") ? join(homedir(), env.slice(2)) : env;
	return join(homedir(), ".pi", "agent");
}

/** Expand a leading `~/` using the current user's home directory. */
export function expandHome(path: string): string {
	return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

// Cache path layout

export interface CachePaths {
	dir: string;
	usage: string;
	ledger: string;
}

/**
 * Pure: return usage and ledger paths for an attachment under
 * `<agentDir>/cache/quota-providers/<providerId>/`.
 */
export function cachePaths(agentDir: string, providerId: string): CachePaths {
	const dir = join(agentDir, "cache", "quota-providers", providerId);
	return {
		dir,
		usage: join(dir, "usage.json"),
		ledger: join(dir, "ledger.jsonl"),
	};
}
