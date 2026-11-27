import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SubagentJsonValue, SubagentMessageInput, SubagentPresentation, SubagentToolCallInput } from "@pimote/sdk/subagents";
import { createSubagentPresenters } from "./presenters.js";

/**
 * One saved shape from an earlier my-pi version. `expected` lists what the
 * card must show; `absent` lists dotted paths the output must not hold.
 */
type Fixture = Readonly<{
	shape: string;
	toolCall?: SubagentToolCallInput;
	message?: SubagentMessageInput;
	expected: unknown;
	absent?: readonly string[];
}>;

const directory = join(import.meta.dirname, "fixtures", "legacy-presentation");
const fixtures = readdirSync(directory)
	.filter((file) => file.endsWith(".json"))
	.toSorted()
	.map((file) => ({ file, fixture: JSON.parse(readFileSync(join(directory, file), "utf8")) as Fixture }));

const presenters = createSubagentPresenters({ runningToolProgress: () => undefined });

function present(fixture: Fixture): SubagentPresentation | readonly SubagentPresentation[] | undefined {
	if (fixture.toolCall) {return presenters.presentToolCall(fixture.toolCall);}
	if (fixture.message) {return presenters.presentMessage(fixture.message);}
	throw new Error("fixture has no input");
}

function member(value: unknown, path: string): SubagentJsonValue | undefined {
	return path.split(".").reduce<SubagentJsonValue | undefined>((current, key) => (current !== null && typeof current === "object" ? (current as Record<string, SubagentJsonValue>)[key] : undefined), value as SubagentJsonValue);
}

/** Correlation identifiers the saved input holds, as values or as content attributes. */
function correlationIds(input: unknown): string[] {
	const ids: string[] = [];
	const visit = (value: unknown, key?: string): void => {
		if (typeof value === "string") {
			if (key === "correlationId" || key === "correlation_id") {ids.push(value);}
			for (const match of value.matchAll(/correlation_id="([^"]+)"/g)) {ids.push(match[1]);}
		} else if (Array.isArray(value)) {
			for (const item of value) {visit(item);}
		} else if (value !== null && typeof value === "object") {
			for (const [childKey, child] of Object.entries(value)) {visit(child, childKey);}
		}
	};
	visit(input);
	return ids;
}

describe("legacy presentation corpus", () => {
	it("holds fixtures for tool results and custom messages", () => {
		expect(fixtures.some(({ fixture }) => fixture.toolCall)).toBe(true);
		expect(fixtures.some(({ fixture }) => fixture.message)).toBe(true);
	});

	it.each(fixtures)("$file", ({ fixture }) => {
		const output = present(fixture);
		if (fixture.expected === null) {
			expect(output).toBeUndefined();
			return;
		}
		expect(output).toMatchObject(fixture.expected as object);
		for (const path of fixture.absent ?? []) {expect(member(output, path), path).toBeUndefined();}

		const json = JSON.stringify(output);
		expect(json).not.toMatch(/"(correlationId|correlation_id|pendingCorrelations|pending_correlations)"/);
		expect(json).not.toMatch(/corr-[0-9a-f]+-\d+/);
		for (const id of correlationIds(fixture.toolCall ?? fixture.message)) {expect(json).not.toContain(id);}
	});
});
