import { existsSync, readFileSync } from "node:fs";
import type { UsageSnapshot } from "./types.js";

export interface UsageSnapshotFile {
  writtenAt: number;
  snapshots: UsageSnapshot[];
  /** Backward-compatible alias populated when there is exactly one window. */
  snapshot?: UsageSnapshot;
}

export function isUsageSnapshot(value: unknown): value is UsageSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  return (
    typeof snapshot.spend === "number" && Number.isFinite(snapshot.spend) &&
    typeof snapshot.quota === "number" && Number.isFinite(snapshot.quota) &&
    typeof snapshot.windowStart === "number" && Number.isFinite(snapshot.windowStart) &&
    typeof snapshot.windowEnd === "number" && Number.isFinite(snapshot.windowEnd) &&
    typeof snapshot.asOf === "number" && Number.isFinite(snapshot.asOf) &&
    (snapshot.limitId === undefined || typeof snapshot.limitId === "string") &&
    (snapshot.label === undefined || typeof snapshot.label === "string")
  );
}

export function readUsageSnapshot(path: string): UsageSnapshotFile | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, { encoding: "utf8" }));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const file = parsed as Record<string, unknown>;
    if (typeof file.writtenAt !== "number") return null;

    const snapshots = Array.isArray(file.snapshots)
      ? file.snapshots
      : isUsageSnapshot(file.snapshot)
        ? [file.snapshot]
        : null;
    if (!snapshots || !snapshots.every(isUsageSnapshot)) return null;

    return {
      writtenAt: file.writtenAt,
      snapshots,
      ...(snapshots.length === 1 ? { snapshot: snapshots[0] } : {}),
    };
  } catch {
    return null;
  }
}
