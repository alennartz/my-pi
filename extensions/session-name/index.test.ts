import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Helpers ─────────────────────────────────────────────────────────────────

type ToolDef = {
	name: string;
	exposure?: string;
	annotations?: Record<string, boolean>;
	execute: (toolCallId: string, params: any, signal?: any, onUpdate?: any, ctx?: any) => Promise<any>;
};

type MockPi = ReturnType<typeof mockPi>;

let tool: ToolDef;
let factory: (pi: any) => void;

/**
 * Emulates pi's session name semantics: setSessionName() normalizes like
 * appendSessionInfo() (line breaks to spaces, trim) and an empty name clears
 * the title, so getSessionName() reads back undefined.
 */
function mockPi(initialName?: string) {
	const state = { name: initialName, appends: [] as string[] };
	const api = {
		registerTool: vi.fn((def: ToolDef) => {
			tool = def;
		}),
		getSessionName: () => state.name,
		setSessionName: (raw: string) => {
			state.appends.push(raw);
			state.name = raw.replace(/[\r\n]+/g, " ").trim() || undefined;
		},
	};
	return { state, api };
}

/** Register the tool against a fresh stub so each test owns its session state. */
function setup(initialName?: string): MockPi {
	const mock = mockPi(initialName);
	factory(mock.api);
	return mock;
}

function text(result: { content: { type: string; text: string }[] }): string {
	return result.content[0].text;
}

beforeEach(async () => {
	const mod = await import("./index.ts");
	factory = mod.default;
});

// ─── Registration ────────────────────────────────────────────────────────────

describe("registration", () => {
	it("registers a direct, idempotent tool", () => {
		setup();
		expect(tool.name).toBe("set_session_name");
		expect(tool.exposure ?? "direct").toBe("direct");
		expect(tool.annotations?.idempotentHint).toBe(true);
		expect(tool.annotations?.readOnlyHint).toBe(false);
	});
});

// ─── Setting names ───────────────────────────────────────────────────────────

describe("setting names", () => {
	it("sets the session name and reports the effective value", async () => {
		const { state } = setup();
		const result = await tool.execute("t1", { name: "fix webhook retry backoff" });
		expect(state.name).toBe("fix webhook retry backoff");
		expect(text(result)).toContain('"fix webhook retry backoff"');
		expect(result.details).toEqual({ name: "fix webhook retry backoff", previous: null });
	});

	it("normalizes line breaks and surrounding whitespace", async () => {
		const { state } = setup();
		await tool.execute("t1", { name: "  fix\nretry\nbackoff  " });
		expect(state.name).toBe("fix retry backoff");
	});

	it("reports the previous name", async () => {
		setup("old name");
		const result = await tool.execute("t1", { name: "new name" });
		expect(result.details).toEqual({ name: "new name", previous: "old name" });
	});

	it("does not append an entry when the name is unchanged", async () => {
		const { state } = setup("same name");
		const result = await tool.execute("t1", { name: "  same name  " });
		expect(state.appends).toEqual([]);
		expect(text(result)).toContain("unchanged");
	});

	it("does nothing when clearing a session that has no name", async () => {
		const { state } = setup();
		const result = await tool.execute("t1", { name: "   " });
		expect(state.appends).toEqual([]);
		expect(text(result)).toContain("no name");
	});
});

// ─── Clearing names ──────────────────────────────────────────────────────────

describe("clearing names", () => {
	it("clears the name with an empty string and reports the previous name", async () => {
		const { state } = setup("old name");
		const result = await tool.execute("t1", { name: "" });
		expect(state.name).toBeUndefined();
		expect(text(result)).toContain("cleared");
		expect(text(result)).toContain('"old name"');
		expect(result.details).toEqual({ name: null, previous: "old name" });
	});
});

// ─── Validation ──────────────────────────────────────────────────────────────

describe("validation", () => {
	it("rejects names longer than 200 characters", async () => {
		const { state } = setup();
		await expect(tool.execute("t1", { name: "x".repeat(201) })).rejects.toThrow(/at most 200 characters/);
		expect(state.name).toBeUndefined();
		expect(state.appends).toEqual([]);
	});

	it("measures length after normalization", async () => {
		setup();
		await expect(tool.execute("t1", { name: "x".repeat(105) + "\n" + "x".repeat(105) })).rejects.toThrow(/got 211/);
	});

	it("accepts a 200-character name padded with whitespace", async () => {
		const { state } = setup();
		await tool.execute("t1", { name: "x".repeat(200) + "\n\n\n" });
		expect(state.name).toBe("x".repeat(200));
	});
});
