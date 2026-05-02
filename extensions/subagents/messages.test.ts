import { describe, expect, it } from "vitest";
import {
	serializeAgentComplete,
	serializeGroupComplete,
	type AgentCompleteData,
} from "./messages.js";

describe("serializeAgentComplete", () => {
	it("includes session_id attribute and resurrect hint when sessionId is present (idle)", () => {
		const xml = serializeAgentComplete({
			id: "scout-1",
			status: "idle",
			output: "all done",
			sessionId: "3adc73ee-27b3-420d-bc9f-73f37c244e2f",
		});
		expect(xml).toContain('session_id="3adc73ee-27b3-420d-bc9f-73f37c244e2f"');
		expect(xml).toContain("<hint>");
		expect(xml).toContain("resurrect tool");
		expect(xml).toContain("all done");
	});

	it("includes session_id and hint on failed status too", () => {
		const xml = serializeAgentComplete({
			id: "scout-1",
			status: "failed",
			error: "boom",
			sessionId: "abc-123",
		});
		expect(xml).toContain('status="failed"');
		expect(xml).toContain('session_id="abc-123"');
		expect(xml).toContain("<hint>");
	});

	it("omits session_id and hint when sessionId is absent", () => {
		const xml = serializeAgentComplete({
			id: "scout-1",
			status: "idle",
			output: "done",
		});
		expect(xml).not.toContain("session_id=");
		expect(xml).not.toContain("<hint>");
	});
});

describe("serializeGroupComplete", () => {
	const usage = { input: "1k", output: "500", cost: "$0.0010" };

	it("emits session_id per agent and exactly one <hint> per envelope", () => {
		const data = {
			agents: [
				{ id: "scout-1", status: "idle" as const, sessionId: "uuid-1" },
				{ id: "impl-1", status: "idle" as const, sessionId: "uuid-2" },
			] satisfies AgentCompleteData[],
			usage,
		};
		const xml = serializeGroupComplete(data);
		expect(xml).toContain('session_id="uuid-1"');
		expect(xml).toContain('session_id="uuid-2"');
		const hintCount = (xml.match(/<hint>/g) ?? []).length;
		expect(hintCount).toBe(1);
		// hint appears before the usage line
		expect(xml.indexOf("<hint>")).toBeLessThan(xml.indexOf("<usage"));
	});

	it("omits hint when no agent has a sessionId", () => {
		const xml = serializeGroupComplete({
			agents: [{ id: "scout-1", status: "idle" as const }],
			usage,
		});
		expect(xml).not.toContain("session_id=");
		expect(xml).not.toContain("<hint>");
	});

	it("includes hint when at least one agent has a sessionId", () => {
		const xml = serializeGroupComplete({
			agents: [
				{ id: "a", status: "failed" as const, error: "x" },
				{ id: "b", status: "idle" as const, sessionId: "uuid-x" },
			] satisfies AgentCompleteData[],
			usage,
		});
		expect(xml).toContain('session_id="uuid-x"');
		expect((xml.match(/<hint>/g) ?? []).length).toBe(1);
	});
});
