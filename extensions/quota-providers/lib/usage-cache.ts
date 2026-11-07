import { existsSync, readFileSync } from "node:fs";
import type { UsageSnapshot } from "./types.js";

/** The atomic cache record written by the quota usage runner. */
export interface UsageCacheFile {
	writtenAt: number;
	snapshots: UsageSnapshot[];
	modelLimitIds: Record<string, string[]>;
}

function isUsageSnapshot(value: unknown): value is UsageSnapshot {
	if (!isRecord(value)) return false;
	const snapshot = value as Record<string, unknown>;
	return typeof snapshot.spend === "number" && Number.isFinite(snapshot.spend)
		&& typeof snapshot.quota === "number" && Number.isFinite(snapshot.quota)
		&& typeof snapshot.windowStart === "number" && Number.isFinite(snapshot.windowStart)
		&& typeof snapshot.windowEnd === "number" && Number.isFinite(snapshot.windowEnd)
		&& typeof snapshot.asOf === "number" && Number.isFinite(snapshot.asOf)
		&& (snapshot.limitId === undefined || typeof snapshot.limitId === "string")
		&& (snapshot.label === undefined || typeof snapshot.label === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModelLimitIds(value: unknown): value is Record<string, string[]> {
	if (!isRecord(value)) return false;
	return Object.values(value).every(
		(limitIds) => Array.isArray(limitIds) && limitIds.every((limitId) => typeof limitId === "string"),
	);
}

/** Read one complete snapshot-plus-model-map cache record. */
export function readUsageCache(path: string): UsageCacheFile | null {
	if (!existsSync(path)) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, { encoding: "utf8" }));
		if (!isRecord(parsed)) return null;
		if (typeof parsed.writtenAt !== "number" || !Number.isFinite(parsed.writtenAt)) return null;
		if (!Array.isArray(parsed.snapshots) || !parsed.snapshots.every(isUsageSnapshot)) return null;
		if (!isModelLimitIds(parsed.modelLimitIds)) return null;

		return {
			writtenAt: parsed.writtenAt,
			snapshots: parsed.snapshots,
			modelLimitIds: parsed.modelLimitIds,
		};
	} catch {
		return null;
	}
}
