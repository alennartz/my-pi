/**
 * In-memory TTL/LRU cache for search responses.
 * Contract: docs/plans/web-tools.md → Interfaces → Search cache.
 */

interface Entry<T> {
	value: T;
	expiresAt: number;
}

export class TtlLruCache<T> {
	private cache = new Map<string, Entry<T>>();

	constructor(
		private readonly ttlMs: number,
		private readonly maxEntries: number,
		private readonly now: () => number = Date.now,
	) {}

	get(key: string): T | undefined {
		const entry = this.cache.get(key);
		if (!entry) return undefined;
		if (this.now() > entry.expiresAt) {
			this.cache.delete(key);
			return undefined;
		}
		// LRU: refresh recency.
		this.cache.delete(key);
		this.cache.set(key, entry);
		return entry.value;
	}

	set(key: string, value: T): void {
		if (this.cache.size >= this.maxEntries) {
			const oldest = this.cache.keys().next().value;
			if (oldest !== undefined) this.cache.delete(oldest);
		}
		this.cache.set(key, { value, expiresAt: this.now() + this.ttlMs });
	}

	clear(): void {
		this.cache.clear();
	}

	get size(): number {
		return this.cache.size;
	}
}
