import * as path from "node:path";
import type { AgentPath } from "./agent-path.js";
import {
	readEvents,
	type AgentLifecycleEvent,
	type PersistencePaths,
} from "./persistence.js";
import { parseSessionSnapshot, type SessionSnapshot } from "./session-snapshot.js";

/** Durable lifecycle/topology facts projected from my-pi's existing records. */
export type SubagentLifecycleRecordKind =
	| "node_added"
	| "node_updated"
	| "node_removed"
	| "completion"
	| "interrupt"
	| "teardown"
	| "resurrect";

/** Status reconstructed from a saved child session at read time. */
export type SubagentLifecycleStatus = Readonly<{
	/** A restored child has no live run until its runtime starts again. */
	state: "idle";
	usage: SessionSnapshot["usage"];
	model?: string;
	lastOutput?: string;
	lastTurnInput: number;
}>;

/** Details retained beside a persisted topology fact. */
export type SubagentLifecycleRecordData = Readonly<{
	/** The append-only persistence event that produced this fact. */
	source: AgentLifecycleEvent;
	/** Current contents of the associated child session file, when known. */
	snapshot?: SessionSnapshot;
	/** Status projection used when the child is rehydrated. */
	status?: SubagentLifecycleStatus;
	/** True when an old removal did not match the currently live incarnation. */
	stale?: boolean;
	/** Persisted fields are also available without unpacking `source`. */
	[key: string]: unknown;
}>;

export type SubagentLifecycleRecord = Readonly<{
	recordId: string;
	timestamp: string;
	kind: SubagentLifecycleRecordKind;
	path: AgentPath;
	sessionId?: string;
	previousSessionId?: string;
	sessionFile?: string;
	data?: unknown;
}>;

/** Read-only view of append-only lifecycle and child-session persistence. */
export interface SubagentLifecycleReader {
	read(): readonly SubagentLifecycleRecord[];
}

type PersistedRecord = Extract<AgentLifecycleEvent, { type: "agent_added" | "agent_removed" }>;
type ActiveRecord = Readonly<{
	sessionId?: string;
	sessionFile?: string;
}>;

type LifecycleReaderOptions = Readonly<{
	paths: PersistencePaths;
	parentPath: AgentPath;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isPath(value: unknown): value is AgentPath {
	return Array.isArray(value)
		&& value.length > 0
		&& value.every((part) => typeof part === "string" && part.length > 0);
}

function isPersistedEvent(value: unknown): value is PersistedRecord {
	if (!isRecord(value) || (value.type !== "agent_added" && value.type !== "agent_removed")) return false;
	return typeof value.timestamp === "string" && typeof value.id === "string" && value.id.length > 0;
}

function pathKey(agentPath: AgentPath): string {
	return JSON.stringify(agentPath);
}

function copyPath(agentPath: AgentPath): AgentPath {
	return [...agentPath];
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function eventPath(event: Record<string, unknown>, parentPath: AgentPath): AgentPath | undefined {
	const persistedPath = event.path;
	if (isPath(persistedPath) && persistedPath.length > 0) return [...parentPath, ...persistedPath];
	const id = stringValue(event.id);
	return id === undefined ? undefined : [...parentPath, id];
}

function resolveSessionFile(paths: PersistencePaths, sessionFile: string): string {
	return path.isAbsolute(sessionFile)
		? sessionFile
		: path.resolve(paths.childSessionsDir, sessionFile);
}

function statusFromSnapshot(snapshot: SessionSnapshot): SubagentLifecycleStatus {
	return {
		state: "idle",
		usage: snapshot.usage,
		...(snapshot.model !== undefined ? { model: snapshot.model } : {}),
		...(snapshot.lastOutput !== undefined ? { lastOutput: snapshot.lastOutput } : {}),
		lastTurnInput: snapshot.lastTurnInput,
	};
}

function dataFor(
	paths: PersistencePaths,
	source: AgentLifecycleEvent,
	sessionFile: string | undefined,
	extra: Pick<SubagentLifecycleRecordData, "stale"> = {},
): SubagentLifecycleRecordData {
	const persistedFields = isRecord(source) ? source : {};
	if (sessionFile === undefined) {
		return {
			...persistedFields,
			source,
			...(extra.stale === true ? { stale: true } : {}),
		};
	}
	const snapshot = parseSessionSnapshot(resolveSessionFile(paths, sessionFile));
	return {
		...persistedFields,
		source,
		snapshot,
		status: statusFromSnapshot(snapshot),
		...(extra.stale === true ? { stale: true } : {}),
	};
}

function recordIdFor(event: Record<string, unknown>, index: number): string {
	const persistedId = stringValue(event.recordId);
	if (persistedId !== undefined) return persistedId;
	const type = stringValue(event.type) ?? stringValue(event.kind) ?? "record";
	return `${type}:${index + 1}`;
}

function readRecords(options: LifecycleReaderOptions): readonly SubagentLifecycleRecord[] {
	const events = readEvents(options.paths.logFile) as unknown[];
	const active = new Map<string, ActiveRecord>();
	/** Last known incarnation, retained after removal for resurrection links. */
	const lastKnown = new Map<string, ActiveRecord>();
	const removed = new Set<string>();
	const records: SubagentLifecycleRecord[] = [];

	for (let index = 0; index < events.length; index++) {
		const event = events[index];
		if (!isPersistedEvent(event)) continue;

		const pathValue = eventPath(event, options.parentPath);
		if (pathValue === undefined) continue;
		const key = pathKey(pathValue);
		const current = active.get(key);
		const prior = current ?? lastKnown.get(key);
		const sessionId = stringValue(event.sessionId);
		const sessionFile = stringValue(event.sessionFile) ?? prior?.sessionFile;
		const recordId = recordIdFor(event, index);

		if (event.type === "agent_added") {
			const kind: SubagentLifecycleRecordKind = current
				? "node_updated"
				: removed.has(key)
					? "resurrect"
					: "node_added";
			const record: SubagentLifecycleRecord = {
				recordId,
				timestamp: event.timestamp,
				kind,
				path: copyPath(pathValue),
				...(sessionId !== undefined ? { sessionId } : {}),
				...(prior?.sessionId !== undefined ? { previousSessionId: prior.sessionId } : {}),
				...(sessionFile !== undefined ? { sessionFile } : {}),
				data: dataFor(options.paths, event, sessionFile),
			};
			records.push(record);
			const next = { sessionId, sessionFile };
			active.set(key, next);
			lastKnown.set(key, next);
			removed.delete(key);
			continue;
		}

		const stale = current !== undefined
			&& ((sessionId !== undefined && current.sessionId !== undefined && sessionId !== current.sessionId)
				|| (stringValue(event.sessionFile) !== undefined
					&& current.sessionFile !== undefined
					&& event.sessionFile !== current.sessionFile));
		const record: SubagentLifecycleRecord = {
			recordId,
			timestamp: event.timestamp,
			kind: "node_removed",
			path: copyPath(pathValue),
			...(sessionId ?? current?.sessionId
				? { sessionId: sessionId ?? current?.sessionId }
				: {}),
			...(sessionFile !== undefined ? { sessionFile } : {}),
			data: dataFor(options.paths, event, sessionFile, stale ? { stale: true } : {}),
		};
		records.push(record);
		if (!stale) {
			active.delete(key);
			lastKnown.set(key, {
				sessionId: sessionId ?? current?.sessionId,
				sessionFile,
			});
			removed.add(key);
		}
	}

	return records;
}

/**
 * Read one parent's existing lifecycle log. `parentPath` prefixes records when
 * a nested manager supplies its owner path. The optional argument keeps the
 * original one-argument construction contract intact.
 */
export function createSubagentLifecycleReader(
	paths: PersistencePaths,
	parentPath: AgentPath = [],
): SubagentLifecycleReader {
	const options: LifecycleReaderOptions = { paths, parentPath: copyPath(parentPath) };
	return {
		read: () => readRecords(options),
	};
}
