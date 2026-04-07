import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
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

	it("includes global root first when agentDir has AGENTS.md", () => {
		const agentDir = createTemp();
		const cwd = createTemp();
		writeFileSync(join(agentDir, "AGENTS.md"), "global");
		writeFileSync(join(cwd, "AGENTS.md"), "project");

		const roots = discoverContextRoots(cwd, agentDir);
		expect(roots[0]).toEqual({
			dir: agentDir,
			baseFilePath: join(agentDir, "AGENTS.md"),
			scope: "global",
		});
		expect(roots.length).toBe(2);
		expect(roots[1].scope).toBe("ancestor");
	});

	it("prefers AGENTS.md over CLAUDE.md when both exist", () => {
		const agentDir = createTemp();
		writeFileSync(join(agentDir, "AGENTS.md"), "agents");
		writeFileSync(join(agentDir, "CLAUDE.md"), "claude");

		const cwd = createTemp();
		const roots = discoverContextRoots(cwd, agentDir);
		expect(roots[0].baseFilePath).toBe(join(agentDir, "AGENTS.md"));
	});

	it("falls back to CLAUDE.md when AGENTS.md is absent", () => {
		const agentDir = createTemp();
		writeFileSync(join(agentDir, "CLAUDE.md"), "claude");

		const cwd = createTemp();
		const roots = discoverContextRoots(cwd, agentDir);
		expect(roots[0].baseFilePath).toBe(join(agentDir, "CLAUDE.md"));
	});

	it("skips directories without context files", () => {
		const agentDir = createTemp(); // no files
		const cwd = createTemp(); // no files

		const roots = discoverContextRoots(cwd, agentDir);
		expect(roots.length).toBe(0);
	});

	it("returns ancestors in farthest → nearest order", () => {
		const base = createTemp();
		const mid = join(base, "a", "b");
		const deep = join(mid, "c");
		mkdirSync(mid, { recursive: true });
		mkdirSync(deep, { recursive: true });
		writeFileSync(join(base, "AGENTS.md"), "root");
		writeFileSync(join(mid, "AGENTS.md"), "mid");
		writeFileSync(join(deep, "AGENTS.md"), "deep");

		const agentDir = createTemp(); // empty, no global root
		const roots = discoverContextRoots(deep, agentDir);

		expect(roots.length).toBe(3);
		expect(roots[0].dir).toBe(base);
		expect(roots[1].dir).toBe(mid);
		expect(roots[2].dir).toBe(deep);
	});

	it("includes cwd itself when it has a context file", () => {
		const agentDir = createTemp();
		const cwd = createTemp();
		writeFileSync(join(cwd, "AGENTS.md"), "project");

		const roots = discoverContextRoots(cwd, agentDir);
		expect(roots.some((r) => r.dir === cwd)).toBe(true);
	});

	it("deduplicates when agentDir is an ancestor of cwd", () => {
		const agentDir = createTemp();
		const cwd = join(agentDir, "sub");
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(agentDir, "AGENTS.md"), "shared");

		const roots = discoverContextRoots(cwd, agentDir);
		// agentDir should appear once as global, not again as ancestor
		expect(roots.filter((r) => r.dir === agentDir).length).toBe(1);
		expect(roots[0].scope).toBe("global");
	});
});
