import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isValidCwd, resolveAgentCwds } from "./agents.js";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-cwd-test-"));
});

afterEach(() => {
	try {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		// best effort
	}
});

describe("isValidCwd", () => {
	it("returns true for an existing directory", () => {
		const dir = path.join(tmpRoot, "exists");
		fs.mkdirSync(dir);
		expect(isValidCwd(dir)).toBe(true);
	});

	it("returns false when the path does not exist", () => {
		const missing = path.join(tmpRoot, "nope");
		expect(isValidCwd(missing)).toBe(false);
	});

	it("returns false when the path exists but is a file, not a directory", () => {
		const file = path.join(tmpRoot, "a-file.txt");
		fs.writeFileSync(file, "hi");
		expect(isValidCwd(file)).toBe(false);
	});
});

describe("resolveAgentCwds", () => {
	it("returns an empty map when no agent has a cwd", () => {
		const result = resolveAgentCwds(
			[{ id: "a" }, { id: "b" }],
			tmpRoot,
		);
		expect(result.size).toBe(0);
	});

	it("returns absolute paths unchanged when valid", () => {
		const target = path.join(tmpRoot, "target");
		fs.mkdirSync(target);
		const result = resolveAgentCwds([{ id: "a", cwd: target }], tmpRoot);
		expect(result.get("a")).toBe(target);
	});

	it("resolves a relative cwd against the parentCwd", () => {
		const sub = path.join(tmpRoot, "child");
		fs.mkdirSync(sub);
		const result = resolveAgentCwds([{ id: "a", cwd: "child" }], tmpRoot);
		expect(result.get("a")).toBe(sub);
		expect(path.isAbsolute(result.get("a")!)).toBe(true);
	});

	it("omits agents that did not supply a cwd from the result map", () => {
		const target = path.join(tmpRoot, "t");
		fs.mkdirSync(target);
		const result = resolveAgentCwds(
			[{ id: "a", cwd: target }, { id: "b" }],
			tmpRoot,
		);
		expect(result.has("a")).toBe(true);
		expect(result.has("b")).toBe(false);
	});

	it("throws when a cwd does not exist, mentioning the agent id and the resolved path", () => {
		const missing = path.join(tmpRoot, "missing");
		expect(() =>
			resolveAgentCwds([{ id: "worker-2", cwd: missing }], tmpRoot),
		).toThrow(/worker-2/);
		try {
			resolveAgentCwds([{ id: "worker-2", cwd: missing }], tmpRoot);
		} catch (err: any) {
			expect(err.message).toContain("worker-2");
			expect(err.message).toContain(missing);
		}
	});

	it("throws when a cwd exists but is a file, not a directory", () => {
		const file = path.join(tmpRoot, "not-a-dir");
		fs.writeFileSync(file, "");
		expect(() =>
			resolveAgentCwds([{ id: "w", cwd: file }], tmpRoot),
		).toThrow();
	});

	it("identifies the resolved (absolute) path in the error when given a relative input", () => {
		// "missing-rel" doesn't exist under tmpRoot
		const expectedAbs = path.resolve(tmpRoot, "missing-rel");
		try {
			resolveAgentCwds([{ id: "x", cwd: "missing-rel" }], tmpRoot);
			throw new Error("expected resolveAgentCwds to throw");
		} catch (err: any) {
			expect(err.message).toContain("x");
			expect(err.message).toContain(expectedAbs);
		}
	});

	it("is atomic: a single invalid cwd in a batch throws without returning partial results", () => {
		const good = path.join(tmpRoot, "good");
		fs.mkdirSync(good);
		const bad = path.join(tmpRoot, "bad-missing");
		expect(() =>
			resolveAgentCwds(
				[
					{ id: "ok", cwd: good },
					{ id: "broken", cwd: bad },
				],
				tmpRoot,
			),
		).toThrow();
		// resolveAgentCwds either returns a complete result or throws \u2014 never
		// a partial map. The throw above already proves no Map was returned.
	});

	it("validates every entry, not just the first \u2014 a later invalid cwd still throws", () => {
		const good = path.join(tmpRoot, "g1");
		fs.mkdirSync(good);
		const bad = path.join(tmpRoot, "g2-missing");
		expect(() =>
			resolveAgentCwds(
				[
					{ id: "first", cwd: good },
					{ id: "second", cwd: bad },
				],
				tmpRoot,
			),
		).toThrow(/second/);
	});

	it("accepts an empty batch and returns an empty map", () => {
		expect(resolveAgentCwds([], tmpRoot).size).toBe(0);
	});
});
