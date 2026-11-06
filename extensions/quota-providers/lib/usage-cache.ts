import type { UsageSnapshot } from "./types.js";

/** The atomic cache record written by the quota usage runner. */
export interface UsageCacheFile {
	writtenAt: number;
	snapshots: UsageSnapshot[];
	modelLimitIds: Record<string, string[]>;
}

/** Read one complete snapshot-plus-model-map cache record. */
export function readUsageCache(_path: string): UsageCacheFile | null {
	throw new Error("not implemented");
}
