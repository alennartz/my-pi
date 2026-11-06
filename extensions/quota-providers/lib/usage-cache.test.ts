import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { readUsageCache } from "./usage-cache.js";

describe("usage snapshot cache", () => {
	it("reads snapshots and their model-to-limit map as one cache record", () => {
		const path = join(tmpdir(), `quota-usage-${process.pid}.json`);
		writeFileSync(path, JSON.stringify({
			writtenAt: 123,
			snapshots: [{
				spend: 12,
				quota: 100,
				windowStart: 0,
				windowEnd: 1000,
				asOf: 500,
			}],
			modelLimitIds: { "premium-model": ["premium-weekly"] },
		}), "utf8");

		try {
			const cache = readUsageCache(path);
			expect(cache).toEqual({
				writtenAt: 123,
				snapshots: [{
					spend: 12,
					quota: 100,
					windowStart: 0,
					windowEnd: 1000,
					asOf: 500,
				}],
				modelLimitIds: { "premium-model": ["premium-weekly"] },
			});
		} finally {
			try {
				unlinkSync(path);
			} catch {
			}
		}
	});

	it("rejects a cache that does not carry the model map with its snapshots", () => {
		const path = join(tmpdir(), `quota-usage-incomplete-${process.pid}.json`);
		writeFileSync(path, JSON.stringify({
			writtenAt: 123,
			snapshots: [],
		}), "utf8");

		try {
			expect(readUsageCache(path)).toBeNull();
		} finally {
			try {
				unlinkSync(path);
			} catch {
			}
		}
	});
});
