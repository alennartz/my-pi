import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LedgerEntry } from "./types.js";

export function parseLedger(raw: string): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        typeof parsed.timestamp === "number" &&
        typeof parsed.cost === "number"
      ) {
        entries.push({ timestamp: parsed.timestamp, cost: parsed.cost });
      }
    } catch {
      // torn or garbage line — skip
    }
  }
  return entries;
}

export function pruneLedger(entries: LedgerEntry[], asOf: number): LedgerEntry[] {
  return entries.filter((e) => e.timestamp > asOf);
}

export function appendLedgerEntry(path: string, entry: LedgerEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n", { encoding: "utf8" });
}

export function readLedger(path: string): LedgerEntry[] {
  try {
    return parseLedger(readFileSync(path, { encoding: "utf8" }));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
