import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	appendAgentAdded,
	ensurePersistence,
	findAgentRecordBySessionId,
	loadPersistedAgents,
	pruneInvalidPersistedAgents,
	type PersistedAgentRecord,
	type PersistencePaths,
} from "./persistence.js";

let tmpRoot: string;
let parentSessionFile: string;
let paths: PersistencePaths;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-persist-test-"));
	parentSessionFile = path.join(tmpRoot, "parent.jsonl");
	fs.writeFileSync(parentSessionFile, "");
	paths = ensurePersistence(parentSessionFile);
});

afterEach(() => {
	try {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		// best effort
	}
});

function baseRecord(overrides: Partial<PersistedAgentRecord> = {}): PersistedAgentRecord {
	return {
		id: "a",
		kind: "agent",
		task: "do work",
		channels: [],
		sessionFile: path.join(paths.childSessionsDir, "stub.jsonl"),
		sessionId: "11111111-1111-4111-8111-111111111111",
		...overrides,
	};
}

describe("PersistedAgentRecord cwd round-trip", () => {
	it("preserves cwd through appendAgentAdded \u2192 loadPersistedAgents", () => {
		const cwd = path.join(tmpRoot, "project-b");
		fs.mkdirSync(cwd);
		appendAgentAdded(paths, baseRecord({ cwd }));

		const loaded = loadPersistedAgents(parentSessionFile);
		expect(loaded).not.toBeNull();
		expect(loaded!.agents).toHaveLength(1);
		expect(loaded!.agents[0].cwd).toBe(cwd);
	});

	it("leaves cwd absent when none was persisted", () => {
		appendAgentAdded(paths, baseRecord());
		const loaded = loadPersistedAgents(parentSessionFile);
		expect(loaded!.agents[0].cwd).toBeUndefined();
	});

	it("loads legacy log lines (no cwd field) as records with no cwd", () => {
		// Simulate a record written before the cwd field existed by writing
		// a minimal JSONL line by hand.
		const line = JSON.stringify({
			type: "agent_added",
			version: 1,
			timestamp: new Date().toISOString(),
			id: "legacy",
			kind: "agent",
			task: "old work",
			channels: [],
			sessionFile: path.join(paths.childSessionsDir, "legacy.jsonl"),
			sessionId: "22222222-2222-4222-8222-222222222222",
		});
		fs.appendFileSync(paths.logFile, line + "\n");

		const loaded = loadPersistedAgents(parentSessionFile);
		expect(loaded!.agents).toHaveLength(1);
		expect(loaded!.agents[0].id).toBe("legacy");
		expect(loaded!.agents[0].cwd).toBeUndefined();
	});

	it("exposes cwd through findAgentRecordBySessionId", () => {
		const cwd = path.join(tmpRoot, "project-c");
		fs.mkdirSync(cwd);
		const sessionId = "33333333-3333-4333-8333-333333333333";
		appendAgentAdded(paths, baseRecord({ id: "scout", sessionId, cwd }));

		const found = findAgentRecordBySessionId(parentSessionFile, sessionId);
		expect(found).toBeDefined();
		expect(found!.cwd).toBe(cwd);
	});

	it("findAgentRecordBySessionId returns undefined cwd when none was persisted", () => {
		const sessionId = "44444444-4444-4444-8444-444444444444";
		appendAgentAdded(paths, baseRecord({ id: "noc", sessionId }));
		const found = findAgentRecordBySessionId(parentSessionFile, sessionId);
		expect(found!.cwd).toBeUndefined();
	});
});

describe("pruneInvalidPersistedAgents", () => {
	it("keeps records whose cwd still validates", () => {
		const valid = path.join(tmpRoot, "still-here");
		fs.mkdirSync(valid);
		const rec = baseRecord({ id: "ok", cwd: valid });
		const result = pruneInvalidPersistedAgents(paths, [rec], () => true);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("ok");
	});

	it("keeps records with no cwd unconditionally (no validation call)", () => {
		const rec = baseRecord({ id: "no-cwd" });
		let called = false;
		const result = pruneInvalidPersistedAgents(paths, [rec], () => {
			called = true;
			return false;
		});
		expect(result).toHaveLength(1);
		expect(called).toBe(false);
	});

	it("drops records whose cwd no longer validates", () => {
		const gone = path.join(tmpRoot, "deleted");
		const rec = baseRecord({ id: "broken", cwd: gone });
		const result = pruneInvalidPersistedAgents(paths, [rec], () => false);
		expect(result).toHaveLength(0);
	});

	it("drops only the failing records, keeping the rest (independent failures)", () => {
		const goodDir = path.join(tmpRoot, "good");
		fs.mkdirSync(goodDir);
		const badDir = path.join(tmpRoot, "bad");
		const records = [
			baseRecord({ id: "good", sessionId: "g-sid", cwd: goodDir }),
			baseRecord({ id: "bad", sessionId: "b-sid", cwd: badDir }),
			baseRecord({ id: "no-cwd", sessionId: "n-sid" }),
		];
		const result = pruneInvalidPersistedAgents(
			paths,
			records,
			(absPath) => absPath === goodDir,
		);
		const ids = result.map((r) => r.id).sort();
		expect(ids).toEqual(["good", "no-cwd"]);
	});

	it("emits agent_removed events that cancel out the persisted agent on next load", () => {
		const badDir = path.join(tmpRoot, "bad");
		const sessionId = "55555555-5555-4555-8555-555555555555";
		const rec = baseRecord({ id: "dropme", sessionId, cwd: badDir });

		// Record the agent as added in the log
		appendAgentAdded(paths, rec);

		// Confirm baseline: it's currently live
		let loaded = loadPersistedAgents(parentSessionFile);
		expect(loaded!.agents.map((a) => a.id)).toContain("dropme");

		// Prune it (should write agent_removed)
		pruneInvalidPersistedAgents(paths, [rec], () => false);

		// Reload: the dropped agent must no longer appear in the live set
		loaded = loadPersistedAgents(parentSessionFile);
		expect(loaded!.agents.map((a) => a.id)).not.toContain("dropme");
	});

	it("returns an empty array when given empty input", () => {
		expect(pruneInvalidPersistedAgents(paths, [], () => true)).toEqual([]);
	});
});

describe("PersistedAgentRecord fork tools/skillPaths round-trip", () => {
	it("preserves tools and skillPaths through appendAgentAdded → loadPersistedAgents", () => {
		appendAgentAdded(paths, baseRecord({
			id: "clone",
			kind: "fork",
			tools: ["read", "bash"],
			skillPaths: ["/skills/debugging/SKILL.md"],
		}));

		const loaded = loadPersistedAgents(parentSessionFile);
		expect(loaded).not.toBeNull();
		const record = loaded!.agents.find((a) => a.id === "clone");
		expect(record?.tools).toEqual(["read", "bash"]);
		expect(record?.skillPaths).toEqual(["/skills/debugging/SKILL.md"]);
	});

	it("preserves tools and skillPaths through findAgentRecordBySessionId", () => {
		const sessionId = "22222222-2222-4222-8222-222222222222";
		appendAgentAdded(paths, baseRecord({
			id: "clone",
			kind: "fork",
			sessionId,
			tools: ["read"],
			skillPaths: ["/skills/x/SKILL.md"],
		}));

		const record = findAgentRecordBySessionId(parentSessionFile, sessionId);
		expect(record?.tools).toEqual(["read"]);
		expect(record?.skillPaths).toEqual(["/skills/x/SKILL.md"]);
	});

	it("leaves tools/skillPaths undefined for legacy records", () => {
		appendAgentAdded(paths, baseRecord());
		const loaded = loadPersistedAgents(parentSessionFile);
		expect(loaded!.agents[0]!.tools).toBeUndefined();
		expect(loaded!.agents[0]!.skillPaths).toBeUndefined();
	});
});
