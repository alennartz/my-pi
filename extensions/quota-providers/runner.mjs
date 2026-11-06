#!/usr/bin/env node
/**
 * Run a quota source outside pi's extension process.
 *
 * The runner polls usage, atomically stores snapshots with model membership,
 * and prunes entries that the returned snapshots now cover.
 */

import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const LOCK_STALE_MS = 60_000;
const POLICY_KEYS = new Set([
	"module",
	"enabled",
	"bypassAllowed",
	"lookaheadHours",
	"maxPollSeconds",
	"enforceHardCap",
]);

function fail(message) {
	process.stderr.write(`quota-providers-runner: ${message}\n`);
	process.exit(1);
}

function parseArgs(argv) {
	const flags = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--module") flags.module = argv[++index];
		else if (arg === "--impl") flags.impl = argv[++index];
		else if (arg === "--config") flags.config = argv[++index];
		else if (arg === "--cache") flags.cache = argv[++index];
		else if (arg === "--max-poll-seconds") flags.maxPollSeconds = Number(argv[++index]);
		else if (arg === "--ledger") flags.ledger = argv[++index];
	}
	return flags;
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}

function isUsageSnapshot(value) {
	if (!isRecord(value)) return false;
	return (
		isFiniteNumber(value.spend) &&
		isFiniteNumber(value.quota) &&
		isFiniteNumber(value.windowStart) &&
		isFiniteNumber(value.windowEnd) &&
		isFiniteNumber(value.asOf) &&
		(value.limitId === undefined || typeof value.limitId === "string") &&
		(value.label === undefined || typeof value.label === "string")
	);
}

function isModelLimitIds(value) {
	return isRecord(value) && Object.values(value).every(
		(limitIds) => Array.isArray(limitIds) && limitIds.every((limitId) => typeof limitId === "string"),
	);
}

function isQuotaSourceResult(value) {
	return (
		isRecord(value) &&
		Array.isArray(value.snapshots) &&
		value.snapshots.every(isUsageSnapshot) &&
		isModelLimitIds(value.modelLimitIds)
	);
}

function parseUsageCache(raw) {
	try {
		const parsed = JSON.parse(raw);
		if (!isRecord(parsed)) return null;
		if (!isFiniteNumber(parsed.writtenAt)) return null;
		if (!Array.isArray(parsed.snapshots) || !parsed.snapshots.every(isUsageSnapshot)) return null;
		if (!isModelLimitIds(parsed.modelLimitIds)) return null;
		return parsed;
	} catch {
		return null;
	}
}

function readUsageCache(path) {
	if (!existsSync(path)) return null;
	try {
		return parseUsageCache(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/** Atomically replace a file with data written in the same directory. */
function writeAtomic(path, data) {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(temporaryPath, data, "utf8");
	renameSync(temporaryPath, path);
}

/**
 * Acquire an exclusive lock. A stale lock is safe to steal after one minute.
 * Contention times out so a caller never waits indefinitely.
 */
function acquireLockSync(path) {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		let fd;
		try {
			fd = openSync(path, "wx");
			try {
				writeFileSync(fd, String(process.pid), "utf8");
			} finally {
				closeSync(fd);
			}
			return {
				acquired: true,
				release: () => {
					try { unlinkSync(path); } catch { /* already gone */ }
				},
			};
		} catch (error) {
			if (fd !== undefined) {
				try { closeSync(fd); } catch { /* non-fatal */ }
			}
			if (error?.code !== "EEXIST") {
				return { acquired: false, release: () => {} };
			}

			let modifiedAt;
			try {
				modifiedAt = statSync(path).mtimeMs;
			} catch {
				continue;
			}
			if (Date.now() - modifiedAt >= LOCK_STALE_MS) {
				try { unlinkSync(path); } catch { /* another process removed it */ }
				continue;
			}

			const spinEnd = Date.now() + 5;
			while (Date.now() < spinEnd) { /* short contention spin */ }
		}
	}
	return { acquired: false, release: () => {} };
}

async function loadQuotaSource(modulePath) {
	const { createJiti } = await import("jiti");
	const jiti = createJiti(import.meta.url, { interopDefault: true });
	const loaded = await jiti.import(modulePath);
	if (loaded && typeof loaded.getUsage === "function") return loaded;
	if (loaded?.default && typeof loaded.default.getUsage === "function") return loaded.default;
	return loaded;
}

function buildSettings(configPath, providerId) {
	if (!configPath || !existsSync(configPath)) return {};
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf8"));
	} catch {
		return {};
	}
	const block = parsed?.providers?.[providerId];
	if (!isRecord(block)) return {};
	const settings = {};
	for (const [key, value] of Object.entries(block)) {
		if (!POLICY_KEYS.has(key)) settings[key] = value;
	}
	return settings;
}

function cacheIsFresh(path, maxPollSeconds) {
	const cached = readUsageCache(path);
	if (!cached) return false;
	const now = Date.now();
	if (cached.snapshots.some((snapshot) => now >= snapshot.windowEnd)) return false;
	return (now - cached.writtenAt) / 1000 < maxPollSeconds;
}

function pruneLedger(path, asOf) {
	if (!existsSync(path)) return;
	const lock = acquireLockSync(`${path}.lock`);
	try {
		const kept = readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => {
				if (!line.trim()) return false;
				try {
					const entry = JSON.parse(line);
					return typeof entry.timestamp !== "number" || entry.timestamp > asOf;
				} catch {
					return true;
				}
			})
			.join("\n");
		writeAtomic(path, kept ? `${kept}\n` : "");
	} catch {
		// Ledger pruning is best effort. Usage remains authoritative in the cache.
	} finally {
		lock.release();
	}
}

async function runUsage(flags, source, context) {
	const cachePath = flags.cache;
	const ledgerPath = flags.ledger;
	const maxPollSeconds = Number.isFinite(flags.maxPollSeconds) ? flags.maxPollSeconds : 300;
	if (!cachePath) fail("usage: --cache <path> is required");
	if (!ledgerPath) fail("usage: --ledger <path> is required");
	if (!source || typeof source.getUsage !== "function") {
		fail("usage: source does not export getUsage");
	}

	mkdirSync(dirname(cachePath), { recursive: true });
	const usageLock = acquireLockSync(`${cachePath}.lock`);
	if (!usageLock.acquired) return;
	try {
		if (cacheIsFresh(cachePath, maxPollSeconds)) return;

		let result;
		try {
			result = await source.getUsage(context);
		} catch (error) {
			usageLock.release();
			fail(`usage: source.getUsage failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!isQuotaSourceResult(result)) {
			usageLock.release();
			fail("usage: source.getUsage returned invalid result — expected snapshots and modelLimitIds");
		}

		writeAtomic(cachePath, JSON.stringify({
			writtenAt: Date.now(),
			snapshots: result.snapshots,
			modelLimitIds: result.modelLimitIds,
		}));

		if (result.snapshots.length === 0) return;
		const asOf = Math.min(...result.snapshots.map((snapshot) => snapshot.asOf));
		pruneLedger(ledgerPath, asOf);
	} finally {
		usageLock.release();
	}
}

const [command, ...rest] = process.argv.slice(2);
const flags = parseArgs(rest);
if (command !== "usage") {
	fail(`unknown command "${command ?? ""}" (expected: usage)`);
}
if (!flags.module) fail("usage: --module <implPath> is required");
if (!flags.impl) fail("usage: --impl <implId> is required");

const source = await loadQuotaSource(flags.module);
if (!isRecord(source)) fail(`could not load source from "${flags.module}"`);
const context = { settings: buildSettings(flags.config, flags.impl) };
await runUsage(flags, source, context);
