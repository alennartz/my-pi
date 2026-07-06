#!/usr/bin/env node
/**
 * Azure Foundry helper — invoked out-of-band by the azure-foundry extension.
 *
 * Two responsibilities, both kept OFF pi's synchronous extension-factory path:
 *
 *   token --cache <path>
 *     Print a valid Azure AD access token to stdout. Self-caching: reads the
 *     cache file and only calls `az account get-access-token` when the cached
 *     token is missing or near expiry. This is what pi runs as the provider's
 *     `!command` apiKey (pi re-runs it per request, uncached on pi's side, so
 *     the caching has to live here).
 *
 *   refresh-deployments --cache <path>
 *     Run Foundry deployment discovery via `az` and write the result to the
 *     cache file (atomically). Reads AZURE_FOUNDRY_* from the environment.
 *     Run synchronously (block-once) on a cold cache miss, or detached in the
 *     background to refresh the cache for the next pi (re)build.
 *
 * Plain Node, no pi imports — runnable by a bare `node`.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry
const TOKEN_HARD_MARGIN_MS = 30 * 1000; // never use a token within 30s of expiry
const AZ_RESOURCE =
	process.env.AZURE_FOUNDRY_TOKEN_RESOURCE || "https://cognitiveservices.azure.com";

function fail(msg) {
	process.stderr.write(`azure-foundry-helper: ${msg}\n`);
	process.exit(1);
}

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--cache") out.cache = argv[++i];
	}
	return out;
}

/** Atomic replace: write to a unique temp in the same dir, then rename. */
function writeAtomic(path, data) {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(tmp, data, "utf-8");
	renameSync(tmp, path);
}

function az(args, timeout) {
	// execFile (no shell) — avoids /bin/sh, shell parsing, and injection via
	// account/resource-group/subscription strings.
	return execFileSync("az", args, { encoding: "utf-8", timeout });
}

// ---------------------------------------------------------------------------
// token
// ---------------------------------------------------------------------------

/**
 * Cache shape (current):
 *   { accessToken: string, softExpiresAt: number, hardExpiresAt: number }
 *
 * - softExpiresAt: when we *want* to start refreshing (real expiry − 5 min).
 *   Past this, we still return the cached token but kick a detached refresh.
 * - hardExpiresAt: when the token is no longer safe to use (real expiry − 30 s).
 *   Past this, we block on a synchronous refresh.
 *
 * Older caches (only `expiresAt`) are treated as a miss — one-time block, then
 * rewritten in the new shape.
 */
function readCachedToken(cachePath) {
	if (!cachePath || !existsSync(cachePath)) return null;
	try {
		const parsed = JSON.parse(readFileSync(cachePath, "utf-8"));
		if (
			typeof parsed?.accessToken === "string" &&
			typeof parsed?.softExpiresAt === "number" &&
			typeof parsed?.hardExpiresAt === "number"
		) {
			return parsed;
		}
	} catch {
		// torn/garbage cache — treat as miss
	}
	return null;
}

/** Synchronously call `az` and write a fresh token to cachePath. Returns the token. */
function refreshTokenSync(cachePath, prior) {
	let raw;
	try {
		raw = az(["account", "get-access-token", "--resource", AZ_RESOURCE, "-o", "json"], 15_000).trim();
	} catch (err) {
		// Fall back to a stale-but-present token rather than breaking the request
		// outright; only hard-fail if we have nothing at all.
		if (prior) return prior.accessToken;
		fail(`token: az failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!raw) fail("token: az returned empty response. Is `az login` still valid?");

	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		fail("token: could not parse az output as JSON");
	}
	const token = parsed.accessToken;
	if (!token) fail("token: az returned no accessToken. Is `az login` still valid?");

	const expiresAt = new Date(parsed.expiresOn).getTime();
	if (Number.isNaN(expiresAt)) fail(`token: could not parse expiresOn: "${parsed.expiresOn}"`);

	const softExpiresAt = expiresAt - TOKEN_REFRESH_MARGIN_MS;
	const hardExpiresAt = expiresAt - TOKEN_HARD_MARGIN_MS;

	try {
		writeAtomic(cachePath, JSON.stringify({ accessToken: token, softExpiresAt, hardExpiresAt }));
	} catch {
		// Non-fatal: still return the token even if the cache write failed.
	}
	return token;
}

/** Fire-and-forget self-spawn that re-runs this helper as `refresh-token` and detaches. */
function spawnRefreshDetached(cachePath) {
	try {
		const child = spawn(process.execPath, [process.argv[1], "refresh-token", "--cache", cachePath], {
			detached: true,
			stdio: "ignore",
		});
		child.unref();
	} catch {
		// best-effort
	}
}

function cmdToken(cachePath) {
	if (!cachePath) fail("token: --cache <path> is required");

	const now = Date.now();
	const cached = readCachedToken(cachePath);

	if (cached && now < cached.hardExpiresAt) {
		// Cached token still safe to use — return it immediately.
		process.stdout.write(cached.accessToken);
		// If we're past the soft margin, kick a background refresh for next request.
		if (now >= cached.softExpiresAt) spawnRefreshDetached(cachePath);
		return;
	}

	// Hard-expired or missing — must block to get a usable token.
	const token = refreshTokenSync(cachePath, cached);
	process.stdout.write(token);
}

/** Refresh subcommand — no stdout. Used by detached background refreshes. */
function cmdRefreshToken(cachePath) {
	if (!cachePath) fail("refresh-token: --cache <path> is required");
	const cached = readCachedToken(cachePath);
	refreshTokenSync(cachePath, cached);
}

// ---------------------------------------------------------------------------
// refresh-deployments
// ---------------------------------------------------------------------------

/** Determine the backend for a deployment based on its format and capabilities. */
function resolveBackend(format, capabilities) {
	if (format === "Anthropic") return "anthropic-messages";
	if (format === "OpenAI") {
		if (capabilities.responses === "true") return "openai-responses";
		if (capabilities.chatCompletion === "true") return "openai-completions";
	}
	return null; // embeddings / unknown / non-chat
}

function cmdRefreshDeployments(cachePath) {
	if (!cachePath) fail("refresh-deployments: --cache <path> is required");

	const account = process.env.AZURE_FOUNDRY_ACCOUNT;
	const resourceGroup = process.env.AZURE_FOUNDRY_RESOURCE_GROUP;
	const subscription = process.env.AZURE_FOUNDRY_SUBSCRIPTION;
	if (!account || !resourceGroup) {
		fail("refresh-deployments: AZURE_FOUNDRY_ACCOUNT and AZURE_FOUNDRY_RESOURCE_GROUP are required");
	}

	const args = ["cognitiveservices", "account", "deployment", "list", "-n", account, "-g", resourceGroup];
	if (subscription) args.push("--subscription", subscription);
	args.push("-o", "json");

	let raw;
	try {
		raw = az(args, 30_000);
	} catch (err) {
		fail(`refresh-deployments: az failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	let items;
	try {
		items = JSON.parse(raw);
	} catch {
		fail("refresh-deployments: could not parse az output as JSON");
	}

	const deployments = [];
	for (const item of items) {
		const props = item?.properties ?? {};
		if (props.provisioningState !== "Succeeded") continue;
		const format = props.model?.format;
		const capabilities = props.capabilities ?? {};
		const backend = resolveBackend(format, capabilities);
		if (!backend) continue;
		deployments.push({ deploymentName: item.name, modelName: props.model?.name, backend });
	}

	writeAtomic(cachePath, JSON.stringify({ writtenAt: Date.now(), deployments }));
}

// ---------------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
const { cache } = parseArgs(rest);

switch (cmd) {
	case "token":
		cmdToken(cache);
		break;
	case "refresh-token":
		cmdRefreshToken(cache);
		break;
	case "refresh-deployments":
		cmdRefreshDeployments(cache);
		break;
	default:
		fail(`unknown command "${cmd ?? ""}" (expected: token | refresh-token | refresh-deployments)`);
}
