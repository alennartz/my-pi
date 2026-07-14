import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import type { LedgerEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Lock helpers — mirrors the lock discipline in runner.mjs so appends and
// prunes never race (prune reads ledger then renames; an interleaved append
// would be clobbered, causing spend to undercount).
// ---------------------------------------------------------------------------

const LOCK_STALE_MS = 60_000;

/**
 * Try to acquire a lock file using O_EXCL, with stale-lock stealing.
 * Returns true if we own the lock, false on unexpected errors.
 * Spins (busy-poll) if a fresh lock is held — the prune holds it for
 * < a few ms, so contention is brief.
 */
function acquireLockSync(lockPath: string): boolean {
  const deadline = Date.now() + 10_000; // 10 s hard cap
  while (Date.now() < deadline) {
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, "wx");
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
        fd = undefined;
      }
      return true;
    } catch (err) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        // Unexpected error — proceed without lock rather than blocking indefinitely.
        return false;
      }
      // Lock exists — check staleness.
      try {
        const mtime = statSync(lockPath).mtimeMs;
        if (Date.now() - mtime >= LOCK_STALE_MS) {
          // Stale lock — steal it.
          try { unlinkSync(lockPath); } catch { /* already gone */ }
          continue;
        }
      } catch {
        // Lock vanished between our EEXIST and statSync — retry.
        continue;
      }
      // Fresh lock held by cmdUsage prune — busy-spin up to 5 ms per attempt.
      const spinEnd = Date.now() + 5;
      while (Date.now() < spinEnd) { /* spin */ }
    }
  }
  return false; // timed out — proceed without lock
}

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

/**
 * Append one cost entry to the ledger file.
 *
 * When `usageLockPath` is provided the function acquires the usage lock before
 * writing so the prune in `cmdUsage` (which holds the same lock) cannot
 * clobber the append with its read→filter→rename sequence.
 */
export function appendLedgerEntry(
  path: string,
  entry: LedgerEntry,
  usageLockPath?: string,
): void {
  mkdirSync(dirname(path), { recursive: true });
  let lockAcquired = false;
  if (usageLockPath) {
    lockAcquired = acquireLockSync(usageLockPath);
  }
  try {
    appendFileSync(path, JSON.stringify(entry) + "\n", { encoding: "utf8" });
  } finally {
    if (lockAcquired && usageLockPath) {
      try { unlinkSync(usageLockPath); } catch { /* already gone */ }
    }
  }
}

export function readLedger(path: string): LedgerEntry[] {
  try {
    return parseLedger(readFileSync(path, { encoding: "utf8" }));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
