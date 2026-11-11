import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createSubagentLifecycleReader,
	type SubagentLifecycleRecord,
	type SubagentLifecycleRecordKind,
} from "./lifecycle.js";
import type { PersistencePaths } from "./persistence.js";

let tmpRoot: string;
let paths: PersistencePaths;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-lifecycle-test-"));
	paths = {
		rootDir: tmpRoot,
		childSessionsDir: path.join(tmpRoot, "sessions"),
		logFile: path.join(tmpRoot, "agents.jsonl"),
	};
	fs.mkdirSync(paths.childSessionsDir, { recursive: true });
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function record(
	kind: SubagentLifecycleRecordKind,
	overrides: Partial<SubagentLifecycleRecord> = {},
): SubagentLifecycleRecord {
	return {
		recordId: `${kind}-1`,
		timestamp: "2026-01-01T00:00:00.000Z",
		kind,
		path: ["worker"],
		sessionId: "session-a",
		...overrides,
	};
}

function writeRecords(lines: readonly (SubagentLifecycleRecord | string)[]): void {
	fs.writeFileSync(
		paths.logFile,
		lines.map((line) => typeof line === "string" ? line : JSON.stringify(line)).join("\n") + "\n",
		"utf8",
	);
}

describe("SubagentLifecycleReader", () => {
	it("replays valid records in append order and skips malformed lines", () => {
		const added = record("node_added");
		const removed = record("node_removed", { sessionId: "session-a" });
		writeRecords([added, "not-json", removed]);

		const reader = createSubagentLifecycleReader(paths);
		const records = reader.read();

		expect(records).toEqual([added, removed]);
	});

	it("retains the public path while recording a runtime replacement", () => {
		const replacement = record("node_updated", {
			sessionId: "session-b",
			previousSessionId: "session-a",
		});
		writeRecords([replacement]);

		const reader = createSubagentLifecycleReader(paths);
		const [actual] = reader.read();

		expect(actual).toMatchObject({
			kind: "node_updated",
			path: ["worker"],
			previousSessionId: "session-a",
			sessionId: "session-b",
		});
	});

	it("keeps the saved child session reference across teardown and resurrection", () => {
		const sessionFile = path.join(paths.childSessionsDir, "worker.jsonl");
		const tornDown = record("teardown", { sessionFile, sessionId: "session-a" });
		const resurrected = record("resurrect", {
			recordId: "resurrect-1",
			sessionFile,
			sessionId: "session-c",
		});
		writeRecords([tornDown, resurrected]);

		const reader = createSubagentLifecycleReader(paths);
		const records = reader.read();

		expect(records.map((item) => item.path)).toEqual([["worker"], ["worker"]]);
		expect(records.map((item) => item.sessionFile)).toEqual([sessionFile, sessionFile]);
		expect(records.map((item) => item.sessionId)).toEqual(["session-a", "session-c"]);
	});
});
