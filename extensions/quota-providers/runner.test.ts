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
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const directory = dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = join(directory, "runner.mjs");
const SOURCE_PATH = join(directory, "test", "fake-impl.ts");

type ProviderSettings = Record<string, unknown>;

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "quota-runner-test-"));
}

function writeConfig(configPath: string, settings: ProviderSettings): void {
	writeFileSync(configPath, JSON.stringify({
		providers: {
			fake: {
				module: SOURCE_PATH,
				enabled: true,
				...settings,
			},
		},
	}), "utf8");
}

interface RunResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

function runRunner(args: string[]): RunResult {
	const result = spawnSync(process.execPath, [RUNNER_PATH, ...args], {
		encoding: "utf8",
		timeout: 30_000,
	});
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

describe("runner.mjs — usage", () => {
	let tempDir: string;
	let configPath: string;
	let cachePath: string;
	let ledgerPath: string;

	beforeEach(() => {
		tempDir = makeTempDir();
		configPath = join(tempDir, "quota-providers.json");
		cachePath = join(tempDir, "usage.json");
		ledgerPath = join(tempDir, "ledger.jsonl");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	const snapshot = {
		spend: 10.5,
		quota: 100,
		windowStart: Date.now() - 86_400_000,
		windowEnd: Date.now() + 86_400_000,
		asOf: Date.now() - 5_000,
	};

	function runUsage(maxPollSeconds = 300): RunResult {
		return runRunner([
			"usage",
			"--module", SOURCE_PATH,
			"--impl", "fake",
			"--config", configPath,
			"--cache", cachePath,
			"--ledger", ledgerPath,
			"--max-poll-seconds", String(maxPollSeconds),
		]);
	}

	it("writes snapshots and prunes ledger entries through the earliest asOf", () => {
		writeConfig(configPath, { usage: snapshot });
		const oldEntry = JSON.stringify({ timestamp: snapshot.asOf - 1_000, cost: 0.05 });
		const newEntry = JSON.stringify({ timestamp: snapshot.asOf + 1_000, cost: 0.07 });
		writeFileSync(ledgerPath, `${oldEntry}\n${newEntry}\n`, "utf8");

		const result = runUsage();
		expect(result.status).toBe(0);
		expect(existsSync(cachePath)).toBe(true);
		const written = JSON.parse(readFileSync(cachePath, "utf8"));
		expect(typeof written.writtenAt).toBe("number");
		expect(written.snapshots).toEqual([snapshot]);
		expect(written.modelLimitIds).toEqual({});

		const ledger = readFileSync(ledgerPath, "utf8");
		expect(ledger).not.toContain(oldEntry);
		expect(ledger).toContain(newEntry);
	});

	it("does not rewrite a fresh cache", () => {
		writeConfig(configPath, { usage: snapshot });
		const first = runUsage();
		expect(first.status).toBe(0);
		const firstWrittenAt = JSON.parse(readFileSync(cachePath, "utf8")).writtenAt as number;

		const second = runUsage(300);
		expect(second.status).toBe(0);
		const secondWrittenAt = JSON.parse(readFileSync(cachePath, "utf8")).writtenAt as number;
		expect(secondWrittenAt).toBe(firstWrittenAt);
	});

	it("refreshes a cache whose usage window has expired", () => {
		const counterPath = join(tempDir, "counter.json");
		const expiredSnapshot = {
			...snapshot,
			windowEnd: Date.now() - 1,
		};
		writeConfig(configPath, { usage: expiredSnapshot, counterFile: counterPath });

		expect(runUsage(300).status).toBe(0);
		expect(runUsage(300).status).toBe(0);
		expect(JSON.parse(readFileSync(counterPath, "utf8")).count).toBe(2);
	});
});
