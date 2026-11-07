import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentRecords, guidanceTablePasses, tierRow, tierTableBlock } from "./run.mjs";

const prompt = [
	"prefix",
	"## Model Tiers",
	"",
	"| Tier | Use when |",
	"| --- | --- |",
	"| cheap | Quick codebase scouting, file discovery, and factual documentation updates. |",
	"| medium | Routine implementation or summaries |",
	"| smart | Test strategy, debugging easily reproduced issues, discussing design tradeoffs. |",
	"| frontier | code review, debugging rare bugs or races security/reliability/performance analysis. |",
	"",
	"suffix",
].join("\n");

test("scopes tier rows to the Model Tiers section", () => {
	const table = tierTableBlock(prompt);
	assert.equal(tierRow(table, "cheap"), "Quick codebase scouting, file discovery, and factual documentation updates.");
	assert.equal(guidanceTablePasses(table), true);
});

test("does not match an unrelated cheap row before the scoped table", () => {
	const table = tierTableBlock("| cheap | unrelated |\n" + prompt);
	assert.equal(tierRow(table, "cheap"), "Quick codebase scouting, file discovery, and factual documentation updates.");
});

test("keeps child session evidence after an agent_removed record", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-tier-fixture-"));
	const log = path.join(dir, "agents.jsonl");
	fs.writeFileSync(log, [
		JSON.stringify({ type: "agent_added", id: "tier", sessionFile: "/tmp/tier.jsonl" }),
		JSON.stringify({ type: "agent_removed", id: "tier" }),
	].join("\n") + "\n");
	assert.deepEqual(agentRecords(log).map((entry) => entry.id), ["tier"]);
	fs.rmSync(dir, { recursive: true, force: true });
});
