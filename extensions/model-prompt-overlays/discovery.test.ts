import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { discoverContextRoots } from "./discovery.ts";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "overlay-discovery-"));
}

describe("discoverContextRoots", () => {
	const tempDirs: string[] = [];

	function createTemp(): string {
		const dir = makeTempDir();
		tempDirs.push(dir);
		return dir;
	}

	afterEach(() => {
		for (const dir of tempDirs) {
			rmSync(dir, { recursive: true, force: true });
		}
		tempDirs.length = 0;
	});

	it("places the global agent dir first", () => {
		const agentDir = createTemp();
		const cwd = createTemp();

		const roots = discoverContextRoots(cwd, agentDir);
		expect(roots[0]).toBe(resolve(agentDir));
	});

	it("does not require an AGENTS.md or CLAUDE.md anchor", () => {
		// No context files anywhere — overlay-only directories must still be roots.
		const agentDir = createTemp();
		const cwd = createTemp();

		const roots = discoverContextRoots(cwd, agentDir);
		expect(roots).toContain(resolve(agentDir));
		expect(roots).toContain(resolve(cwd));
	});

	it("walks ancestors from filesystem root down to cwd", () => {
		const base = createTemp();
		const mid = join(base, "a", "b");
		const deep = join(mid, "c");
		mkdirSync(deep, { recursive: true });

		const agentDir = createTemp();
		const roots = discoverContextRoots(deep, agentDir);

		// Global agent dir is first; then ancestors in farthest → nearest order
		// up through cwd. Find the indices of our known dirs and assert order.
		const iBase = roots.indexOf(resolve(base));
		const iMid = roots.indexOf(resolve(mid));
		const iDeep = roots.indexOf(resolve(deep));

		expect(iBase).toBeGreaterThan(-1);
		expect(iMid).toBeGreaterThan(-1);
		expect(iDeep).toBeGreaterThan(-1);
		expect(iBase).toBeLessThan(iMid);
		expect(iMid).toBeLessThan(iDeep);
	});

	it("includes cwd itself as a root", () => {
		const agentDir = createTemp();
		const cwd = createTemp();

		const roots = discoverContextRoots(cwd, agentDir);
		expect(roots).toContain(resolve(cwd));
	});

	it("deduplicates when agentDir is an ancestor of cwd", () => {
		const agentDir = createTemp();
		const cwd = join(agentDir, "sub");
		mkdirSync(cwd, { recursive: true });

		const roots = discoverContextRoots(cwd, agentDir);
		const matches = roots.filter((r) => r === resolve(agentDir));
		expect(matches.length).toBe(1);
		// Still placed in the "global" slot (first).
		expect(roots[0]).toBe(resolve(agentDir));
	});

	it("walks up to the filesystem root", () => {
		const agentDir = createTemp();
		const cwd = createTemp();

		const roots = discoverContextRoots(cwd, agentDir);
		expect(roots).toContain(resolve("/"));
	});
});
