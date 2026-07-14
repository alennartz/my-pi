import { describe, it, expect } from "vitest";
import { decideBlock } from "./enforce.js";
import type { QuotaVerdict, QuotaPolicy } from "./types.js";

const RESET_AT = Date.now() + 7 * 86_400_000;

function makeVerdict(
  state: QuotaVerdict["state"],
  daysAhead = 0,
): QuotaVerdict {
  return { state, daysAhead, resetAt: RESET_AT };
}

function makePolicy(overrides: Partial<QuotaPolicy> = {}): QuotaPolicy {
  return {
    bypassAllowed: true,
    lookaheadHours: 24,
    maxPollSeconds: 300,
    enforceHardCap: true,
    ...overrides,
  };
}

describe("decideBlock", () => {
  it("soft-exceeded, no bypass → blocked soft", () => {
    const result = decideBlock({
      verdict: makeVerdict("soft-exceeded"),
      policy: makePolicy(),
      bypassActive: false,
    });
    expect(result.blocked).toBe(true);
    if (result.blocked) expect(result.kind).toBe("soft");
  });

  it("soft-exceeded, bypass active → not blocked", () => {
    const result = decideBlock({
      verdict: makeVerdict("soft-exceeded"),
      policy: makePolicy(),
      bypassActive: true,
    });
    expect(result.blocked).toBe(false);
  });

  it("hard-exceeded, enforceHardCap true, no bypass → blocked hard", () => {
    const result = decideBlock({
      verdict: makeVerdict("hard-exceeded"),
      policy: makePolicy({ enforceHardCap: true }),
      bypassActive: false,
    });
    expect(result.blocked).toBe(true);
    if (result.blocked) expect(result.kind).toBe("hard");
  });

  it("hard-exceeded, enforceHardCap true, bypass active → still blocked", () => {
    const result = decideBlock({
      verdict: makeVerdict("hard-exceeded"),
      policy: makePolicy({ enforceHardCap: true }),
      bypassActive: true,
    });
    expect(result.blocked).toBe(true);
    if (result.blocked) expect(result.kind).toBe("hard");
  });

  it("hard-exceeded, enforceHardCap false → not blocked", () => {
    const result = decideBlock({
      verdict: makeVerdict("hard-exceeded"),
      policy: makePolicy({ enforceHardCap: false }),
      bypassActive: false,
    });
    expect(result.blocked).toBe(false);
  });

  it("ok state → not blocked", () => {
    const result = decideBlock({
      verdict: makeVerdict("ok"),
      policy: makePolicy(),
      bypassActive: false,
    });
    expect(result.blocked).toBe(false);
  });

  it("soft message begins exactly 'quota soft cap exceeded'", () => {
    const result = decideBlock({
      verdict: makeVerdict("soft-exceeded"),
      policy: makePolicy(),
      bypassActive: false,
    });
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.message).toMatch(/^quota soft cap exceeded/);
    }
  });

  it("hard message begins exactly 'quota hard cap exceeded'", () => {
    const result = decideBlock({
      verdict: makeVerdict("hard-exceeded"),
      policy: makePolicy({ enforceHardCap: true }),
      bypassActive: false,
    });
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.message).toMatch(/^quota hard cap exceeded/);
    }
  });

  it("bypassAllowed false → message has no bypass hint", () => {
    const result = decideBlock({
      verdict: makeVerdict("soft-exceeded"),
      policy: makePolicy({ bypassAllowed: false }),
      bypassActive: false,
    });
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.message).not.toContain("/quota bypass on");
    }
  });

  it("bypassAllowed true + soft-exceeded → message includes '/quota bypass on'", () => {
    const result = decideBlock({
      verdict: makeVerdict("soft-exceeded"),
      policy: makePolicy({ bypassAllowed: true }),
      bypassActive: false,
    });
    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.message).toContain("/quota bypass on");
    }
  });
});
