import { readFileSync } from "node:fs";
import { writeAtomic } from "./fsio.js";

export type BypassEntries = Record<string, { enabledAt: number }>;

export function parseBypass(raw: string): BypassEntries {
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: BypassEntries = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof (value as Record<string, unknown>).enabledAt === "number"
      ) {
        result[key] = { enabledAt: (value as { enabledAt: number }).enabledAt };
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function pruneBypass(
  entries: BypassEntries,
  now: number,
  windowLengthMs: number,
): BypassEntries {
  const cutoff = now - windowLengthMs;
  const result: BypassEntries = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value.enabledAt >= cutoff) {
      result[key] = value;
    }
  }
  return result;
}

export function readBypass(path: string): BypassEntries {
  try {
    return parseBypass(readFileSync(path, { encoding: "utf8" }));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

export function writeBypass(path: string, entries: BypassEntries): void {
  writeAtomic(path, JSON.stringify(entries, null, 2));
}

export function isBypassActive(entries: BypassEntries, scopeId: string): boolean {
  return Object.prototype.hasOwnProperty.call(entries, scopeId);
}
