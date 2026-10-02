import type { UsageSnapshot, LedgerEntry, QuotaPolicy, QuotaVerdict } from "./types.js";

const DAY_MS = 86_400_000;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Effective spend = snapshot.spend + Σ ledger entries with timestamp > snapshot.asOf. */
export function effectiveSpend(snapshot: UsageSnapshot, ledger: LedgerEntry[]): number {
  const extra = ledger
    .filter((entry) =>
      entry.timestamp > snapshot.asOf &&
      (snapshot.limitId === undefined || entry.quotaLimitIds?.includes(snapshot.limitId) === true),
    )
    .reduce((sum, entry) => sum + entry.cost, 0);
  return snapshot.spend + extra;
}

/**
 * Scopes that apply to a model and still have time left: unscoped snapshots
 * apply to every model, scoped ones only when the model lists their key.
 */
export function applicableSnapshots(
  snapshots: UsageSnapshot[],
  limitIds: string[],
  now: number
): UsageSnapshot[] {
  return snapshots.filter(
    (s) => (s.limitId === undefined || limitIds.includes(s.limitId)) && now < s.windowEnd
  );
}

/** Dollars remaining before the snapshot's hard cap is hit. */
export function remainingHeadroom(snapshot: UsageSnapshot, ledger: LedgerEntry[]): number {
  return snapshot.quota - effectiveSpend(snapshot, ledger);
}

/**
 * The scope that will be hit first: least remaining headroom in dollars,
 * ties broken by the latest reset (windowEnd). Undefined when none apply.
 */
export function firstHitSnapshot(
  snapshots: UsageSnapshot[],
  limitIds: string[],
  ledger: LedgerEntry[],
  now: number
): UsageSnapshot | undefined {
  let best: UsageSnapshot | undefined;
  for (const snapshot of applicableSnapshots(snapshots, limitIds, now)) {
    if (!best) {
      best = snapshot;
      continue;
    }
    const headroom = remainingHeadroom(snapshot, ledger);
    const bestHeadroom = remainingHeadroom(best, ledger);
    if (headroom < bestHeadroom || (headroom === bestHeadroom && snapshot.windowEnd > best.windowEnd)) {
      best = snapshot;
    }
  }
  return best;
}

/** Pro-rated line: quota × clamp((t − windowStart) / (windowEnd − windowStart), 0, 1). */
export function proratedLine(snapshot: UsageSnapshot, t: number): number {
  const windowLength = snapshot.windowEnd - snapshot.windowStart;
  if (windowLength <= 0 || snapshot.quota <= 0) return 0;
  const fraction = clamp((t - snapshot.windowStart) / windowLength, 0, 1);
  return snapshot.quota * fraction;
}

/**
 * How many days ahead of budget the current spend is (can be negative = under budget).
 * Derived by solving: effectiveSpend = proratedLine(now + t)
 * → t = ((spend/quota) × windowLength − (now − windowStart)) / DAY_MS
 */
export function daysAhead(
  snapshot: UsageSnapshot,
  spend: number,
  now: number
): number {
  const { quota, windowStart, windowEnd } = snapshot;
  const windowLength = windowEnd - windowStart;
  if (quota <= 0 || windowLength <= 0) return 0;
  return ((spend / quota) * windowLength - (now - windowStart)) / DAY_MS;
}

/**
 * Evaluate current quota state.
 * - hard-exceeded ⇔ effectiveSpend >= quota (reported regardless of enforceHardCap)
 * - soft-exceeded ⇔ effectiveSpend > proratedLine(now + lookaheadHours in ms)
 * - ok otherwise
 * Degenerate guard: quota <= 0 or windowEnd <= windowStart → ok, daysAhead: 0.
 */
export function evaluateQuota(
  snapshot: UsageSnapshot,
  ledger: LedgerEntry[],
  policy: QuotaPolicy,
  now: number
): QuotaVerdict {
  const { quota, windowEnd, windowStart } = snapshot;
  const resetAt = windowEnd;

  if (quota <= 0 || windowEnd <= windowStart) {
    return { state: "ok", daysAhead: 0, resetAt };
  }

  const spend = effectiveSpend(snapshot, ledger);
  const ahead = daysAhead(snapshot, spend, now);

  if (spend >= quota) {
    return { state: "hard-exceeded", daysAhead: ahead, resetAt };
  }

  const lookaheadMs = policy.lookaheadHours * 3_600_000;
  if (spend > proratedLine(snapshot, now + lookaheadMs)) {
    return { state: "soft-exceeded", daysAhead: ahead, resetAt };
  }

  return { state: "ok", daysAhead: ahead, resetAt };
}
