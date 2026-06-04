import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseSessionSnapshot } from "./session-snapshot.js";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-snapshot-test-"));
});

afterEach(() => {
	try {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		// best effort
	}
});

/** Write JSONL lines to a fresh session file and return its path. */
function writeSession(lines: unknown[]): string {
	const file = path.join(tmpRoot, `${Math.random().toString(36).slice(2)}.jsonl`);
	fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
	return file;
}

/** Build an assistant message session line. */
function assistantLine(opts: {
	model?: string;
	text?: string | string[];
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number };
}): unknown {
	const texts = opts.text === undefined ? [] : Array.isArray(opts.text) ? opts.text : [opts.text];
	const content = texts.map((t) => ({ type: "text", text: t }));
	const message: Record<string, unknown> = { role: "assistant", content };
	if (opts.model !== undefined) message.model = opts.model;
	if (opts.usage) {
		const { cost, ...rest } = opts.usage;
		message.usage = { ...rest, ...(cost !== undefined ? { cost: { total: cost } } : {}) };
	}
	return { type: "message", message };
}

function userLine(text: string): unknown {
	return { type: "message", message: { role: "user", content: [{ type: "text", text }] } };
}

function toolResultLine(payload: string): unknown {
	return { type: "message", message: { role: "toolResult", content: [{ type: "text", text: payload }] } };
}

describe("parseSessionSnapshot — degenerate inputs", () => {
	it("yields a zeroed snapshot for a missing file", () => {
		const snap = parseSessionSnapshot(path.join(tmpRoot, "does-not-exist.jsonl"));
		expect(snap.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });
		expect(snap.lastTurnInput).toBe(0);
		expect(snap.model).toBeUndefined();
		expect(snap.lastOutput).toBeUndefined();
	});

	it("yields a zeroed snapshot for an empty file", () => {
		const file = path.join(tmpRoot, "empty.jsonl");
		fs.writeFileSync(file, "");
		const snap = parseSessionSnapshot(file);
		expect(snap.usage.turns).toBe(0);
		expect(snap.lastTurnInput).toBe(0);
		expect(snap.model).toBeUndefined();
		expect(snap.lastOutput).toBeUndefined();
	});

	it("does not throw on a missing file", () => {
		expect(() => parseSessionSnapshot(path.join(tmpRoot, "nope.jsonl"))).not.toThrow();
	});

	it("yields a zeroed snapshot for an unreadable file (directory path)", () => {
		// A directory path makes fs.readFileSync throw EISDIR — the parser must
		// treat any unreadable file as a zeroed snapshot, never propagate the error.
		const snap = parseSessionSnapshot(tmpRoot);
		expect(snap.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });
		expect(snap.lastTurnInput).toBe(0);
		expect(snap.model).toBeUndefined();
		expect(snap.lastOutput).toBeUndefined();
	});

	it("does not throw on an unreadable file (directory path)", () => {
		expect(() => parseSessionSnapshot(tmpRoot)).not.toThrow();
	});

	it("yields a zeroed snapshot for a session with no assistant messages", () => {
		const file = writeSession([userLine("hello"), toolResultLine("some output")]);
		const snap = parseSessionSnapshot(file);
		expect(snap.usage.turns).toBe(0);
		expect(snap.usage.input).toBe(0);
		expect(snap.model).toBeUndefined();
		expect(snap.lastOutput).toBeUndefined();
	});
});

describe("parseSessionSnapshot — malformed lines", () => {
	it("skips a malformed line without aborting the parse", () => {
		const good = assistantLine({ model: "claude-opus-4-8", text: "ok", usage: { input: 5, output: 7 } });
		const file = path.join(tmpRoot, "mixed.jsonl");
		fs.writeFileSync(file, `${JSON.stringify(good)}\nthis is not json {{{\n`, "utf8");
		const snap = parseSessionSnapshot(file);
		expect(snap.usage.turns).toBe(1);
		expect(snap.usage.input).toBe(5);
		expect(snap.usage.output).toBe(7);
		expect(snap.model).toBe("claude-opus-4-8");
	});
});

describe("parseSessionSnapshot — cumulative usage", () => {
	it("sums usage across every assistant message", () => {
		const file = writeSession([
			assistantLine({ model: "m1", text: "a", usage: { input: 2, output: 408, cacheRead: 40475, cacheWrite: 2086, cost: 0.0434 } }),
			userLine("more"),
			assistantLine({ model: "m1", text: "b", usage: { input: 3, output: 100, cacheRead: 50, cacheWrite: 10, cost: 0.01 } }),
		]);
		const snap = parseSessionSnapshot(file);
		expect(snap.usage.input).toBe(5);
		expect(snap.usage.output).toBe(508);
		expect(snap.usage.cacheRead).toBe(40525);
		expect(snap.usage.cacheWrite).toBe(2096);
		expect(snap.usage.cost).toBeCloseTo(0.0534, 6);
		expect(snap.usage.turns).toBe(2);
	});

	it("treats missing usage sub-fields as zero", () => {
		const file = writeSession([
			assistantLine({ model: "m1", text: "a", usage: { output: 10 } }),
		]);
		const snap = parseSessionSnapshot(file);
		expect(snap.usage.input).toBe(0);
		expect(snap.usage.output).toBe(10);
		expect(snap.usage.cacheRead).toBe(0);
		expect(snap.usage.cacheWrite).toBe(0);
		expect(snap.usage.cost).toBe(0);
		expect(snap.usage.turns).toBe(1);
	});

	it("counts an assistant message with no usage block as a turn with zero contribution", () => {
		const file = writeSession([
			assistantLine({ model: "m1", text: "a" }),
			assistantLine({ model: "m1", text: "b", usage: { input: 4, output: 2 } }),
		]);
		const snap = parseSessionSnapshot(file);
		expect(snap.usage.turns).toBe(2);
		expect(snap.usage.input).toBe(4);
		expect(snap.usage.output).toBe(2);
	});

	it("ignores usage on non-assistant messages", () => {
		const file = writeSession([
			userLine("hi"),
			{ type: "message", message: { role: "user", usage: { input: 999, output: 999 } } },
			assistantLine({ model: "m1", text: "a", usage: { input: 1, output: 1 } }),
		]);
		const snap = parseSessionSnapshot(file);
		expect(snap.usage.turns).toBe(1);
		expect(snap.usage.input).toBe(1);
		expect(snap.usage.output).toBe(1);
	});
});

describe("parseSessionSnapshot — last assistant message", () => {
	it("takes model and lastOutput from the last assistant message in file order", () => {
		const file = writeSession([
			assistantLine({ model: "first-model", text: "first answer", usage: { input: 1 } }),
			assistantLine({ model: "last-model", text: "last answer", usage: { input: 1 } }),
		]);
		const snap = parseSessionSnapshot(file);
		expect(snap.model).toBe("last-model");
		expect(snap.lastOutput).toBe("last answer");
	});

	it("uses the last text part when the last assistant message has multiple text parts", () => {
		const file = writeSession([
			assistantLine({ model: "m1", text: ["intro", "conclusion"], usage: { input: 1 } }),
		]);
		const snap = parseSessionSnapshot(file);
		expect(snap.lastOutput).toBe("conclusion");
	});

	it("keeps the previous lastOutput when the last assistant message has no text part", () => {
		const file = writeSession([
			assistantLine({ model: "m1", text: "earlier text", usage: { input: 1 } }),
			assistantLine({ model: "m2", text: [], usage: { input: 1 } }),
		]);
		const snap = parseSessionSnapshot(file);
		expect(snap.lastOutput).toBe("earlier text");
	});

	it("leaves lastOutput undefined when no assistant message ever had text", () => {
		const file = writeSession([
			assistantLine({ model: "m1", text: [], usage: { input: 1 } }),
		]);
		const snap = parseSessionSnapshot(file);
		expect(snap.lastOutput).toBeUndefined();
	});

	it("takes model from the last assistant message even when that message has no text", () => {
		const file = writeSession([
			assistantLine({ model: "m1", text: "earlier", usage: { input: 1 } }),
			assistantLine({ model: "m2", text: [], usage: { input: 1 } }),
		]);
		const snap = parseSessionSnapshot(file);
		expect(snap.model).toBe("m2");
	});
});

describe("parseSessionSnapshot — lastTurnInput", () => {
	it("derives lastTurnInput from the last assistant turn as input + cacheRead + cacheWrite", () => {
		const file = writeSession([
			assistantLine({ model: "m1", text: "a", usage: { input: 1, cacheRead: 1, cacheWrite: 1 } }),
			assistantLine({ model: "m1", text: "b", usage: { input: 2, cacheRead: 40475, cacheWrite: 2086 } }),
		]);
		const snap = parseSessionSnapshot(file);
		expect(snap.lastTurnInput).toBe(2 + 40475 + 2086);
	});

	it("excludes output tokens from lastTurnInput", () => {
		const file = writeSession([
			assistantLine({ model: "m1", text: "a", usage: { input: 10, output: 9999, cacheRead: 0, cacheWrite: 0 } }),
		]);
		const snap = parseSessionSnapshot(file);
		expect(snap.lastTurnInput).toBe(10);
	});

	it("treats a last assistant message with no usage block as lastTurnInput 0", () => {
		const file = writeSession([
			assistantLine({ model: "m1", text: "a", usage: { input: 5, cacheRead: 5, cacheWrite: 5 } }),
			assistantLine({ model: "m1", text: "b" }),
		]);
		const snap = parseSessionSnapshot(file);
		expect(snap.lastTurnInput).toBe(0);
	});
});

describe("parseSessionSnapshot — non-assistant noise", () => {
	it("ignores user, toolResult, session, and marker lines while still capturing assistant data", () => {
		const file = writeSession([
			{ type: "session", id: "abc" },
			userLine("question"),
			toolResultLine("x".repeat(10000)),
			{ type: "model_change", model: "noise-model" },
			assistantLine({ model: "real-model", text: "real answer", usage: { input: 3, output: 4 } }),
			toolResultLine("y".repeat(5000)),
		]);
		const snap = parseSessionSnapshot(file);
		expect(snap.usage.turns).toBe(1);
		expect(snap.model).toBe("real-model");
		expect(snap.lastOutput).toBe("real answer");
		expect(snap.usage.input).toBe(3);
		expect(snap.usage.output).toBe(4);
	});
});
