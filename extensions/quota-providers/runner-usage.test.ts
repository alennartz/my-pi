import {
	existsSync,
	readFileSync,
	rmSync,
	mkdtempSync,
	writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const directory = dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = join(directory, "runner.mjs");
const SOURCE_PATH = join(directory, "test", "fake-quota-source.ts");

function runRunner(args: string[]) {
	return spawnSync(process.execPath, [RUNNER_PATH, ...args], {
		encoding: "utf8",
		timeout: 30_000,
	});
}

describe("quota runner usage source contract", () => {
	it("writes snapshots and model-limit membership together", () => {
		const root = mkdtempSync(join(tmpdir(), "quota-runner-source-"));
		const config = join(root, "quota-providers.json");
		const cache = join(root, "usage.json");
		const ledger = join(root, "ledger.jsonl");
		writeFileSync(config, JSON.stringify({
			providers: {
				llmgateway: { module: SOURCE_PATH, enabled: true },
			},
		}), "utf8");

		try {
			const result = runRunner([
				"usage",
				"--module", SOURCE_PATH,
				"--impl", "llmgateway",
				"--config", config,
				"--cache", cache,
				"--ledger", ledger,
			]);

			expect(result.status).toBe(0);
			expect(existsSync(cache)).toBe(true);
			expect(JSON.parse(readFileSync(cache, "utf8"))).toMatchObject({
				snapshots: [{ limitId: "monthly", spend: 12, quota: 100 }],
				modelLimitIds: { "premium-model": ["monthly", "premium-weekly"] },
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
