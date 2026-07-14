import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLedger, pruneLedger, appendLedgerEntry, readLedger } from "./ledger.js";

describe("parseLedger", () => {
  it("parses valid JSONL", () => {
    const raw = '{"timestamp":100,"cost":1.5}\n{"timestamp":200,"cost":2.0}\n';
    expect(parseLedger(raw)).toEqual([
      { timestamp: 100, cost: 1.5 },
      { timestamp: 200, cost: 2.0 },
    ]);
  });

  it("skips torn trailing lines", () => {
    const raw = '{"timestamp":100,"cost":1.5}\n{"timestamp":200,"co';
    expect(parseLedger(raw)).toEqual([{ timestamp: 100, cost: 1.5 }]);
  });

  it("skips garbage lines without throwing", () => {
    const raw = '{"timestamp":100,"cost":1.5}\nnot-json\n{"timestamp":300,"cost":3.0}\n';
    expect(parseLedger(raw)).toEqual([
      { timestamp: 100, cost: 1.5 },
      { timestamp: 300, cost: 3.0 },
    ]);
  });

  it("skips lines missing required fields", () => {
    const raw = '{"timestamp":100}\n{"cost":1.5}\n{"timestamp":200,"cost":2.0}\n';
    expect(parseLedger(raw)).toEqual([{ timestamp: 200, cost: 2.0 }]);
  });

  it("returns empty array for empty string", () => {
    expect(parseLedger("")).toEqual([]);
  });
});

describe("pruneLedger", () => {
  const entries = [
    { timestamp: 100, cost: 1 },
    { timestamp: 200, cost: 2 },
    { timestamp: 300, cost: 3 },
  ];

  it("keeps entries with timestamp > asOf", () => {
    expect(pruneLedger(entries, 150)).toEqual([
      { timestamp: 200, cost: 2 },
      { timestamp: 300, cost: 3 },
    ]);
  });

  it("prunes entries with timestamp === asOf", () => {
    expect(pruneLedger(entries, 200)).toEqual([{ timestamp: 300, cost: 3 }]);
  });

  it("prunes all when asOf >= max timestamp", () => {
    expect(pruneLedger(entries, 300)).toEqual([]);
  });

  it("keeps all when asOf < min timestamp", () => {
    expect(pruneLedger(entries, 50)).toEqual(entries);
  });
});

describe("appendLedgerEntry", () => {
  it("creates directory and file on first append", () => {
    const base = mkdtempSync(join(tmpdir(), "ledger-test-"));
    const path = join(base, "sub", "ledger.jsonl");
    const entry = { timestamp: 1000, cost: 0.5 };
    appendLedgerEntry(path, entry);
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    expect(content).toBe(JSON.stringify(entry) + "\n");
  });

  it("appends multiple entries", () => {
    const base = mkdtempSync(join(tmpdir(), "ledger-test-"));
    const path = join(base, "ledger.jsonl");
    appendLedgerEntry(path, { timestamp: 1, cost: 0.1 });
    appendLedgerEntry(path, { timestamp: 2, cost: 0.2 });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ timestamp: 1, cost: 0.1 });
    expect(JSON.parse(lines[1])).toEqual({ timestamp: 2, cost: 0.2 });
  });
});

describe("readLedger", () => {
  it("returns [] for missing file", () => {
    expect(readLedger("/nonexistent/path/ledger.jsonl")).toEqual([]);
  });

  it("round-trips entries through a temp file", () => {
    const base = mkdtempSync(join(tmpdir(), "ledger-test-"));
    const path = join(base, "ledger.jsonl");
    const entries = [
      { timestamp: 500, cost: 5.0 },
      { timestamp: 600, cost: 6.0 },
    ];
    for (const entry of entries) {
      appendLedgerEntry(path, entry);
    }
    expect(readLedger(path)).toEqual(entries);
  });
});
