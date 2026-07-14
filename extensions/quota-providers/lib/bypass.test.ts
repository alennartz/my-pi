import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBypass, pruneBypass, readBypass, writeBypass, isBypassActive } from "./bypass.js";

describe("parseBypass", () => {
  it("parses valid JSON", () => {
    const raw = JSON.stringify({ scope1: { enabledAt: 1000 }, scope2: { enabledAt: 2000 } });
    expect(parseBypass(raw)).toEqual({
      scope1: { enabledAt: 1000 },
      scope2: { enabledAt: 2000 },
    });
  });

  it("returns {} for garbage input", () => {
    expect(parseBypass("not json at all")).toEqual({});
  });

  it("returns {} for JSON array", () => {
    expect(parseBypass("[]")).toEqual({});
  });

  it("returns {} for null", () => {
    expect(parseBypass("null")).toEqual({});
  });

  it("returns {} for empty string", () => {
    expect(parseBypass("")).toEqual({});
  });

  it("skips entries with non-number enabledAt", () => {
    const raw = JSON.stringify({
      good: { enabledAt: 1000 },
      bad: { enabledAt: "not-a-number" },
    });
    expect(parseBypass(raw)).toEqual({ good: { enabledAt: 1000 } });
  });
});

describe("pruneBypass", () => {
  const now = 10_000;
  const windowLengthMs = 5_000;
  // cutoff = now - windowLengthMs = 5000

  const entries = {
    stale: { enabledAt: 4999 },   // < cutoff → pruned
    cutoff: { enabledAt: 5000 },  // === cutoff → kept (>= cutoff)
    fresh: { enabledAt: 7000 },   // > cutoff → kept
  };

  it("drops entries with enabledAt < cutoff", () => {
    const result = pruneBypass(entries, now, windowLengthMs);
    expect(result).not.toHaveProperty("stale");
  });

  it("keeps entries with enabledAt exactly at cutoff", () => {
    const result = pruneBypass(entries, now, windowLengthMs);
    expect(result).toHaveProperty("cutoff");
  });

  it("keeps entries with enabledAt > cutoff", () => {
    const result = pruneBypass(entries, now, windowLengthMs);
    expect(result).toHaveProperty("fresh");
  });

  it("returns empty object when all entries are stale", () => {
    const all_stale = { a: { enabledAt: 1 }, b: { enabledAt: 2 } };
    expect(pruneBypass(all_stale, now, windowLengthMs)).toEqual({});
  });
});

describe("readBypass", () => {
  it("returns {} for missing file", () => {
    expect(readBypass("/nonexistent/path/bypass.json")).toEqual({});
  });
});

describe("writeBypass + readBypass round-trip", () => {
  it("round-trips entries through a temp file", () => {
    const base = mkdtempSync(join(tmpdir(), "bypass-test-"));
    const path = join(base, "bypass.json");
    const entries = {
      scope1: { enabledAt: 1234 },
      scope2: { enabledAt: 5678 },
    };
    writeBypass(path, entries);
    expect(readBypass(path)).toEqual(entries);
  });

  it("creates intermediate directories", () => {
    const base = mkdtempSync(join(tmpdir(), "bypass-test-"));
    const path = join(base, "nested", "dir", "bypass.json");
    writeBypass(path, { s: { enabledAt: 999 } });
    expect(readBypass(path)).toEqual({ s: { enabledAt: 999 } });
  });
});

describe("isBypassActive", () => {
  const entries = { activeScope: { enabledAt: 1000 } };

  it("returns true when scope is present", () => {
    expect(isBypassActive(entries, "activeScope")).toBe(true);
  });

  it("returns false when scope is absent", () => {
    expect(isBypassActive(entries, "missingScope")).toBe(false);
  });

  it("returns false for empty entries", () => {
    expect(isBypassActive({}, "any")).toBe(false);
  });
});
