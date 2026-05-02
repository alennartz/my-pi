import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentSpec } from "./agents.js";

export interface PersistencePaths {
	rootDir: string;
	childSessionsDir: string;
	logFile: string;
}

export interface PersistedAgentRecord {
	id: string;
	kind: AgentSpec["kind"];
	task: string;
	channels: string[];
	agent?: string;
	sessionFile: string;
	sessionId?: string;
}

export type AgentLifecycleEvent =
	| {
			type: "init";
			version: 1;
			timestamp: string;
			parentSessionFile: string;
			childSessionsDir: string;
		}
	| ({
			type: "agent_added";
			version: 1;
			timestamp: string;
		} & PersistedAgentRecord)
	| {
			type: "agent_removed";
			version: 1;
			timestamp: string;
			id: string;
			sessionFile?: string;
			sessionId?: string;
		};

function appendJsonl(file: string, data: unknown): void {
	fs.appendFileSync(file, JSON.stringify(data) + "\n", "utf8");
}

export function getPersistencePaths(parentSessionFile: string): PersistencePaths {
	const dir = path.dirname(parentSessionFile);
	const base = path.basename(parentSessionFile, path.extname(parentSessionFile));
	const rootDir = path.join(dir, `${base}.subagents`);
	const childSessionsDir = path.join(rootDir, "sessions");
	const logFile = path.join(rootDir, "agents.jsonl");
	return { rootDir, childSessionsDir, logFile };
}

export function ensurePersistence(parentSessionFile: string): PersistencePaths {
	const paths = getPersistencePaths(parentSessionFile);
	fs.mkdirSync(paths.childSessionsDir, { recursive: true });
	if (!fs.existsSync(paths.logFile)) {
		appendJsonl(paths.logFile, {
			type: "init",
			version: 1,
			timestamp: new Date().toISOString(),
			parentSessionFile,
			childSessionsDir: paths.childSessionsDir,
		} satisfies AgentLifecycleEvent);
	}
	return paths;
}

export function appendAgentAdded(paths: PersistencePaths, data: PersistedAgentRecord): void {
	appendJsonl(paths.logFile, {
		type: "agent_added",
		version: 1,
		timestamp: new Date().toISOString(),
		...data,
	} satisfies AgentLifecycleEvent);
}

export function appendAgentRemoved(
	paths: PersistencePaths,
	data: { id: string; sessionFile?: string; sessionId?: string },
): void {
	appendJsonl(paths.logFile, {
		type: "agent_removed",
		version: 1,
		timestamp: new Date().toISOString(),
		...data,
	} satisfies AgentLifecycleEvent);
}

/**
 * Scan the raw JSONL log for any `agent_added` event matching `sessionId`,
 * regardless of whether it was subsequently removed. Used by `resurrect` to
 * recover the original persona name for a torn-down agent (which is no longer
 * present in `loadPersistedAgents`'s live-agents view).
 */
export function findAgentRecordBySessionId(
	parentSessionFile: string,
	sessionId: string,
): PersistedAgentRecord | undefined {
	const paths = getPersistencePaths(parentSessionFile);
	if (!fs.existsSync(paths.logFile)) return undefined;
	let contents: string;
	try {
		contents = fs.readFileSync(paths.logFile, "utf8");
	} catch {
		return undefined;
	}
	for (const line of contents.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let event: AgentLifecycleEvent;
		try {
			event = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (event.type === "agent_added" && event.sessionId === sessionId) {
			return {
				id: event.id,
				kind: event.kind,
				task: event.task,
				channels: event.channels,
				agent: event.agent,
				sessionFile: event.sessionFile,
				sessionId: event.sessionId,
			};
		}
	}
	return undefined;
}

export function loadPersistedAgents(parentSessionFile: string): {
	paths: PersistencePaths;
	agents: PersistedAgentRecord[];
} | null {
	const paths = getPersistencePaths(parentSessionFile);
	if (!fs.existsSync(paths.logFile)) return null;

	const lines = fs.readFileSync(paths.logFile, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

	const liveAgents = new Map<string, PersistedAgentRecord>();

	for (const line of lines) {
		let event: AgentLifecycleEvent;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}

		if (event.type === "agent_added") {
			liveAgents.set(event.id, {
				id: event.id,
				kind: event.kind,
				task: event.task,
				channels: event.channels,
				agent: event.agent,
				sessionFile: event.sessionFile,
				sessionId: event.sessionId,
			});
		} else if (event.type === "agent_removed") {
			const current = liveAgents.get(event.id);
			if (!current) continue;
			if (event.sessionId && current.sessionId && event.sessionId !== current.sessionId) continue;
			if (event.sessionFile && current.sessionFile !== event.sessionFile) continue;
			liveAgents.delete(event.id);
		}
	}

	return {
		paths,
		agents: Array.from(liveAgents.values()),
	};
}
