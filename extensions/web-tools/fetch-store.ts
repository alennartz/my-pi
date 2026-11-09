/**
 * Disk-backed page cache. One JSON metadata file and one markdown sidecar per URL
 * under the pi agent dir; survives restarts; front for offset pagination and
 * findText retrieval.
 * Contract: docs/plans/web-tools.md → Interfaces → Disk page cache.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FetchResult } from "./types.js";

export interface StoredFetch {
	/** Full untruncated result. */
	result: FetchResult;
	fetchedAt: number;
	expiresAt: number;
}

export interface FetchStore {
	get(key: string): StoredFetch | null;
	put(key: string, result: FetchResult): void;
	/** Local path to the full untruncated markdown sidecar. */
	pathFor(key: string): string;
	clear(): void;
	get size(): number;
}

export interface FetchStoreOptions {
	ttlMs?: number;
	maxEntries?: number;
	now?: () => number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 1000;

/** Cache key: sha256 of url + extraction-options hash. */
export function cacheKeyFor(url: string, extractionOptsHash = ""): string {
	return createHash("sha256").update(`${url}\n${extractionOptsHash}`).digest("hex");
}

export function defaultCacheDir(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "~", ".pi", "agent");
	return join(agentDir, "web-tools", "cache");
}

export function openFetchStore(dir?: string, opts: FetchStoreOptions = {}): FetchStore {
	const storeDir = dir ?? defaultCacheDir();
	const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
	const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
	const now = opts.now ?? Date.now;

	const fileFor = (key: string) => join(storeDir, `${key}.json`);
	const contentFileFor = (key: string) => join(storeDir, `${key}.md`);

	async function writeAtomic(target: string, content: string): Promise<void> {
		const tmp = join(storeDir, `.${randomBytes(6).toString("hex")}.tmp`);
		await writeFile(tmp, content, "utf-8");
		await rename(tmp, target);
	}

	async function prune(): Promise<void> {
		let names: string[];
		try {
			names = await readdir(storeDir);
		} catch {
			return;
		}
		const jsonFiles = names.filter((n) => n.endsWith(".json"));
		const live: Array<{ name: string; mtime: number; expiresAt: number }> = [];
		for (const name of jsonFiles) {
			const full = join(storeDir, name);
			const key = name.slice(0, -".json".length);
			try {
				const raw = await readFile(full, "utf-8");
				const parsed = JSON.parse(raw) as StoredFetch;
				if (now() > parsed.expiresAt) {
					await rm(full, { force: true });
					await rm(contentFileFor(key), { force: true });
					continue;
				}
				live.push({ name, mtime: (await stat(full)).mtimeMs, expiresAt: parsed.expiresAt });
			} catch {
				await rm(full, { force: true }); // unreadable/corrupt entry is a miss
				await rm(contentFileFor(key), { force: true });
			}
		}
		if (live.length > maxEntries) {
			live.sort((a, b) => a.mtime - b.mtime);
			for (const { name } of live.slice(0, live.length - maxEntries)) {
				await rm(join(storeDir, name), { force: true });
				await rm(contentFileFor(name.slice(0, -".json".length)), { force: true });
			}
		}
		const liveKeys = new Set(live.map(({ name }) => name.slice(0, -".json".length)));
		for (const name of names.filter((entry) => entry.endsWith(".md"))) {
			if (!liveKeys.has(name.slice(0, -".md".length))) {
				await rm(join(storeDir, name), { force: true });
			}
		}
	}

	return {
		async get(key: string): Promise<StoredFetch | null> {
			const full = fileFor(key);
			let raw: string;
			try {
				raw = await readFile(full, "utf-8");
			} catch {
				return null;
			}
			let parsed: StoredFetch;
			try {
				parsed = JSON.parse(raw) as StoredFetch;
			} catch {
				await rm(full, { force: true }); // corrupt entry is a miss, not an error
				await rm(contentFileFor(key), { force: true });
				return null;
			}
			if (now() > parsed.expiresAt) {
				await rm(full, { force: true });
				await rm(contentFileFor(key), { force: true });
				return null;
			}
			const contentPath = contentFileFor(key);
			try {
				await stat(contentPath);
			} catch {
				await writeAtomic(contentPath, parsed.result.markdown);
			}
			return parsed;
		},

		async put(key: string, result: FetchResult): Promise<void> {
			if (result.status !== "ok") return; // only successful fetches are stored
			await mkdir(storeDir, { recursive: true });
			const payload: StoredFetch = {
				result,
				fetchedAt: now(),
				expiresAt: now() + ttlMs,
			};
			await writeAtomic(fileFor(key), JSON.stringify(payload));
			await writeAtomic(contentFileFor(key), result.markdown);
			await prune();
		},

		pathFor(key: string): string {
			return contentFileFor(key);
		},

		async clear(): Promise<void> {
			await rm(storeDir, { recursive: true, force: true });
		},

		async size(): Promise<number> {
			try {
				const names = await readdir(storeDir);
				return names.filter((n) => n.endsWith(".json")).length;
			} catch {
				return 0;
			}
		},
	};
}
