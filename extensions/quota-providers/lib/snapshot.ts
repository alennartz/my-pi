import { existsSync, readFileSync } from "node:fs";
import type { UsageSnapshot } from "./types.js";

export interface UsageSnapshotFile {
  writtenAt: number;
  snapshot: UsageSnapshot;
}

export function readUsageSnapshot(path: string): UsageSnapshotFile | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, { encoding: "utf8" });
    const parsed = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof parsed.writtenAt === "number" &&
      parsed.snapshot !== null &&
      typeof parsed.snapshot === "object" &&
      typeof parsed.snapshot.spend === "number" &&
      typeof parsed.snapshot.quota === "number" &&
      typeof parsed.snapshot.windowStart === "number" &&
      typeof parsed.snapshot.windowEnd === "number" &&
      typeof parsed.snapshot.asOf === "number"
    ) {
      return { writtenAt: parsed.writtenAt, snapshot: parsed.snapshot as UsageSnapshot };
    }
    return null;
  } catch {
    return null;
  }
}
