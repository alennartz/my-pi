import { describe, it, expect } from "vitest";
import {
  effectiveSpend,
  proratedLine,
  daysAhead,
  evaluateQuota,
  applicableSnapshots,
  remainingHeadroom,
  firstHitSnapshot,
} from "./quota.js";
import type { UsageSnapshot, LedgerEntry, QuotaPolicy } from "./types.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** A 30-day window, $100 quota, starting at epoch 0. */
function makeSnapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    spend: 0,
    quota: 100,
    windowStart: 0,
    windowEnd: 30 * DAY_MS,
    asOf: 0,
    ...overrides,
  };
}

const DEFAULT_POLICY: QuotaPolicy = {
  bypassAllowed: true,
  lookaheadHours: 6,
  maxPollSeconds: 300,
  enforceHardCap: false,
};

// ---------------------------------------------------------------------------
// effectiveSpend
// ---------------------------------------------------------------------------

describe("effectiveSpend", () => {
  it("returns snapshot.spend when ledger is empty", () => {
    const s = makeSnapshot({ spend: 42 });
    expect(effectiveSpend(s, [])).toBe(42);
  });

  it("adds ledger entries with timestamp > asOf", () => {
    const s = makeSnapshot({ spend: 10, asOf: 100 });
    const ledger: LedgerEntry[] = [
      { timestamp: 100, cost: 5 },  // <= asOf → ignored
      { timestamp: 101, cost: 3 },  // > asOf → included
      { timestamp: 200, cost: 7 },  // > asOf → included
    ];
    expect(effectiveSpend(s, ledger)).toBe(10 + 3 + 7);
  });

  it("ignores entries with timestamp <= asOf", () => {
    const s = makeSnapshot({ spend: 50, asOf: 500 });
    const ledger: LedgerEntry[] = [
      { timestamp: 499, cost: 100 },
      { timestamp: 500, cost: 100 },
    ];
    expect(effectiveSpend(s, ledger)).toBe(50);
  });

  it("ledger riding on snapshot — entries just after asOf count", () => {
    const s = makeSnapshot({ spend: 20, asOf: 1000 });
    const ledger: LedgerEntry[] = [
      { timestamp: 1001, cost: 5 },
      { timestamp: 2000, cost: 10 },
    ];
    expect(effectiveSpend(s, ledger)).toBe(35);
  });
});

// ---------------------------------------------------------------------------
// proratedLine
// ---------------------------------------------------------------------------

describe("proratedLine", () => {
  it("returns 0 at windowStart", () => {
    const s = makeSnapshot();
    expect(proratedLine(s, s.windowStart)).toBe(0);
  });

  it("returns quota at windowEnd", () => {
    const s = makeSnapshot();
    expect(proratedLine(s, s.windowEnd)).toBe(s.quota);
  });

  it("returns half at midpoint", () => {
    const s = makeSnapshot();
    const mid = (s.windowStart + s.windowEnd) / 2;
    expect(proratedLine(s, mid)).toBeCloseTo(50);
  });

  it("clamps to 0 for t before windowStart", () => {
    const s = makeSnapshot();
    expect(proratedLine(s, s.windowStart - DAY_MS)).toBe(0);
  });

  it("clamps to quota for t after windowEnd", () => {
    const s = makeSnapshot();
    expect(proratedLine(s, s.windowEnd + DAY_MS)).toBe(s.quota);
  });
});

// ---------------------------------------------------------------------------
// daysAhead
// ---------------------------------------------------------------------------

describe("daysAhead", () => {
  it("returns 0 for degenerate quota", () => {
    const s = makeSnapshot({ quota: 0 });
    expect(daysAhead(s, 50, 15 * DAY_MS)).toBe(0);
  });

  it("returns 0 for degenerate window", () => {
    const s = makeSnapshot({ windowEnd: 0 }); // windowEnd <= windowStart
    expect(daysAhead(s, 50, 0)).toBe(0);
  });

  it("returns positive daysAhead when spending ahead of schedule", () => {
    // 30-day window, $100 quota. At day 10, spending $50 (expected $33.33).
    const s = makeSnapshot();
    const now = 10 * DAY_MS;
    const spend = 50;
    // ((50/100) × 30 − 10) / 1 = (15 − 10) = 5 days ahead
    expect(daysAhead(s, spend, now)).toBeCloseTo(5);
  });

  it("returns negative daysAhead when under budget", () => {
    // At day 20, only $30 spent (expected $66.67).
    const s = makeSnapshot();
    const now = 20 * DAY_MS;
    const spend = 30;
    // ((30/100) × 30 − 20) / 1 = (9 − 20) = −11 days
    expect(daysAhead(s, spend, now)).toBeCloseTo(-11);
  });
});

// ---------------------------------------------------------------------------
// evaluateQuota
// ---------------------------------------------------------------------------

describe("evaluateQuota", () => {
  it("returns ok when under budget with no lookahead concern", () => {
    const s = makeSnapshot({ spend: 10, asOf: 0 });
    // At day 15 (midpoint), spend $10 vs prorated $50. Well under.
    const now = 15 * DAY_MS;
    const verdict = evaluateQuota(s, [], DEFAULT_POLICY, now);
    expect(verdict.state).toBe("ok");
    expect(verdict.resetAt).toBe(s.windowEnd);
  });

  it("returns ok when spend exactly equals prorated line (not strictly greater)", () => {
    // At the midpoint the prorated line is $50. Spend exactly $50 → ok.
    const s = makeSnapshot({ spend: 50, asOf: 0 });
    const now = 15 * DAY_MS;
    // With 6h lookahead, proratedLine(now + 6h) is slightly above $50.
    // spend (50) > proratedLine(15.25 days) = 100 × (15.25/30) = $50.83 → false → ok.
    const verdict = evaluateQuota(s, [], DEFAULT_POLICY, now);
    expect(verdict.state).toBe("ok");
  });

  it("returns soft-exceeded when spend exceeds lookahead line", () => {
    // At day 1 with $10 spent (on track for day 3 @ $33/day rate).
    // proratedLine(day 1 + 6h = 1.25 days) = 100 × (1.25/30) ≈ $4.17
    // spend $10 > $4.17 → soft-exceeded.
    const s = makeSnapshot({ spend: 10, asOf: 0 });
    const now = DAY_MS; // day 1
    const verdict = evaluateQuota(s, [], DEFAULT_POLICY, now);
    expect(verdict.state).toBe("soft-exceeded");
    expect(verdict.daysAhead).toBeGreaterThan(0);
    expect(verdict.resetAt).toBe(s.windowEnd);
  });

  it("lookahead boundary — just inside triggers soft-exceeded", () => {
    // Set lookaheadHours = 0 so proratedLine(now) is the threshold.
    const policy = { ...DEFAULT_POLICY, lookaheadHours: 0 };
    // At day 15, proratedLine(day 15) = $50. Spend $50.01 → soft-exceeded.
    const s = makeSnapshot({ spend: 50.01, asOf: 0 });
    const now = 15 * DAY_MS;
    const verdict = evaluateQuota(s, [], policy, now);
    expect(verdict.state).toBe("soft-exceeded");
  });

  it("returns hard-exceeded when spend >= quota", () => {
    const s = makeSnapshot({ spend: 100, asOf: 0 });
    const now = 15 * DAY_MS;
    const verdict = evaluateQuota(s, [], DEFAULT_POLICY, now);
    expect(verdict.state).toBe("hard-exceeded");
  });

  it("hard cap is reported regardless of enforceHardCap flag", () => {
    const policy = { ...DEFAULT_POLICY, enforceHardCap: false };
    const s = makeSnapshot({ spend: 150, asOf: 0 });
    const verdict = evaluateQuota(s, [], policy, 15 * DAY_MS);
    expect(verdict.state).toBe("hard-exceeded");
  });

  it("ledger entries after asOf push spend into soft-exceeded", () => {
    const now = DAY_MS;
    // proratedLine(day 1 + 6h) ≈ $4.17. Base spend $0, but ledger adds $10.
    const s = makeSnapshot({ spend: 0, asOf: 0 });
    const ledger: LedgerEntry[] = [{ timestamp: 1, cost: 10 }];
    const verdict = evaluateQuota(s, ledger, DEFAULT_POLICY, now);
    expect(verdict.state).toBe("soft-exceeded");
  });

  it("ledger entries <= asOf are ignored", () => {
    const s = makeSnapshot({ spend: 5, asOf: 1000 });
    const ledger: LedgerEntry[] = [
      { timestamp: 999, cost: 500 },
      { timestamp: 1000, cost: 500 },
    ];
    // effectiveSpend stays at 5 → well under budget at any reasonable time
    const now = 15 * DAY_MS;
    const verdict = evaluateQuota(s, ledger, DEFAULT_POLICY, now);
    expect(verdict.state).toBe("ok");
  });

  it("degenerate: quota <= 0 → ok with daysAhead 0", () => {
    const s = makeSnapshot({ spend: 999, quota: 0 });
    const verdict = evaluateQuota(s, [], DEFAULT_POLICY, 15 * DAY_MS);
    expect(verdict.state).toBe("ok");
    expect(verdict.daysAhead).toBe(0);
  });

  it("degenerate: windowEnd <= windowStart → ok with daysAhead 0", () => {
    const s = makeSnapshot({ windowEnd: 0 }); // windowEnd === windowStart === 0
    const verdict = evaluateQuota(s, [], DEFAULT_POLICY, DAY_MS);
    expect(verdict.state).toBe("ok");
    expect(verdict.daysAhead).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// applicableSnapshots / remainingHeadroom / firstHitSnapshot
// ---------------------------------------------------------------------------

describe("applicableSnapshots", () => {
  const monthly = makeSnapshot({}); // no limitId → applies to every model
  const premium = makeSnapshot({ limitId: "premium-weekly", windowEnd: 7 * DAY_MS });

  it("keeps unscoped snapshots for models with no scopes", () => {
    expect(applicableSnapshots([monthly, premium], [], 0)).toEqual([monthly]);
  });

  it("keeps a scoped snapshot only when the model lists its key", () => {
    expect(applicableSnapshots([monthly, premium], ["premium-weekly"], 0)).toEqual([
      monthly,
      premium,
    ]);
  });

  it("drops expired windows", () => {
    expect(applicableSnapshots([monthly, premium], [], 31 * DAY_MS)).toEqual([]);
  });
});

describe("remainingHeadroom", () => {
  it("is quota minus snapshot spend", () => {
    expect(remainingHeadroom(makeSnapshot({ spend: 40, quota: 100 }), [])).toBe(60);
  });

  it("subtracts ledger spend beyond asOf", () => {
    const s = makeSnapshot({ spend: 40, quota: 100, asOf: 100 });
    const ledger: LedgerEntry[] = [{ timestamp: 101, cost: 15 }];
    expect(remainingHeadroom(s, ledger)).toBe(45);
  });
});

describe("firstHitSnapshot", () => {
  const now = 5 * DAY_MS;
  const monthly = makeSnapshot({ spend: 90, quota: 100 }); // $10 headroom
  const premium = makeSnapshot({
    limitId: "premium-weekly",
    spend: 10,
    quota: 100,
    windowEnd: 7 * DAY_MS,
  }); // $90 headroom

  it("returns the scope with the least remaining headroom", () => {
    expect(firstHitSnapshot([premium, monthly], ["premium-weekly"], [], now)).toBe(monthly);
  });

  it("ignores scopes the model does not carry", () => {
    expect(firstHitSnapshot([premium, monthly], [], [], now)).toBe(monthly);
    expect(firstHitSnapshot([premium], [], [], now)).toBeUndefined();
  });

  it("accounts for scope-tagged ledger spend when comparing headroom", () => {
    // A second, scoped tier at $10 headroom loses to premium ($90) until the
    // tagged entry lands: 100−(10+85)=5 < 10.
    const taggedMonthly = makeSnapshot({
      limitId: "monthly",
      spend: 90,
      quota: 100,
      windowEnd: 20 * DAY_MS,
    });
    const ledger: LedgerEntry[] = [
      { timestamp: now - 1, cost: 85, quotaLimitIds: ["premium-weekly"] },
    ];
    expect(
      firstHitSnapshot([taggedMonthly, premium], ["monthly", "premium-weekly"], ledger, now),
    ).toBe(premium);
  });

  it("breaks headroom ties by the latest reset", () => {
    const early = makeSnapshot({ spend: 50, quota: 100, windowEnd: 10 * DAY_MS });
    const late = makeSnapshot({ spend: 50, quota: 100, windowEnd: 20 * DAY_MS });
    expect(firstHitSnapshot([early, late], [], [], now)).toBe(late);
  });

  it("drops expired windows before comparing", () => {
    const expired = makeSnapshot({ spend: 100, quota: 100, windowEnd: now - 1 });
    expect(firstHitSnapshot([expired, monthly], [], [], now)).toBe(monthly);
    expect(firstHitSnapshot([expired], [], [], now)).toBeUndefined();
  });
});
