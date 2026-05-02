import { describe, expect, it } from "vitest";
import {
	serializeAgentComplete,
	serializeGroupComplete,
	serializeAgentTorndown,
	serializeGroupTorndown,
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

describe("serializeAgentTorndown", () => {
	it("emits <agent_torn_down> envelope distinct from <agent_idle>", () => {
		const xml = serializeAgentTorndown({
			id: "scout-1",
			status: "idle",
			output: "all done",
			sessionId: "uuid-1",
			alreadyNotified: true,
		});
		expect(xml).toContain("<agent_torn_down");
		expect(xml).toContain("</agent_torn_down>");
		expect(xml).not.toContain("<agent_idle");
	});

	it("omits output body when the agent already notified", () => {
		const xml = serializeAgentTorndown({
			id: "scout-1",
			status: "idle",
			output: "all done",
			sessionId: "uuid-1",
			alreadyNotified: true,
		});
		expect(xml).not.toContain("all done");
		expect(xml).toContain('session_id="uuid-1"');
		expect(xml).toContain("<hint>");
		expect(xml).toContain("resurrect tool");
	});

	it("includes output body when the agent had not yet notified", () => {
		const xml = serializeAgentTorndown({
			id: "scout-1",
			status: "idle",
			output: "partial output",
			sessionId: "uuid-1",
			alreadyNotified: false,
		});
		expect(xml).toContain("partial output");
		expect(xml).toContain('session_id="uuid-1"');
		expect(xml).toContain("<hint>");
	});

	it("includes error body when failed and not yet notified", () => {
		const xml = serializeAgentTorndown({
			id: "scout-1",
			status: "failed",
			error: "boom",
			sessionId: "uuid-1",
			alreadyNotified: false,
		});
		expect(xml).toContain('status="failed"');
		expect(xml).toContain("<error>boom</error>");
	});

	it("omits error body when failed and already notified", () => {
		const xml = serializeAgentTorndown({
			id: "scout-1",
			status: "failed",
			error: "boom",
			sessionId: "uuid-1",
			alreadyNotified: true,
		});
		expect(xml).not.toContain("boom");
		expect(xml).toContain('status="failed"');
		expect(xml).toContain('session_id="uuid-1"');
	});

	it("omits hint when no sessionId is present", () => {
		const xml = serializeAgentTorndown({
			id: "scout-1",
			status: "idle",
			output: "done",
			alreadyNotified: false,
		});
		expect(xml).not.toContain("session_id=");
		expect(xml).not.toContain("<hint>");
	});
});

describe("serializeGroupTorndown", () => {
	const usage = { input: "1k", output: "500", cost: "$0.0010" };

	it("emits <group_torn_down> envelope distinct from <group_complete>", () => {
		const xml = serializeGroupTorndown({
			agents: [{ id: "a", status: "idle" as const, sessionId: "uuid-1", alreadyNotified: true }],
			usage,
		});
		expect(xml).toContain("<group_torn_down>");
		expect(xml).toContain("</group_torn_down>");
		expect(xml).not.toContain("<group_complete>");
	});

	it("renders slim self-closing entries for already-notified agents", () => {
		const xml = serializeGroupTorndown({
			agents: [
				{ id: "a", status: "idle" as const, output: "out-a", sessionId: "uuid-1", alreadyNotified: true },
				{ id: "b", status: "idle" as const, output: "out-b", sessionId: "uuid-2", alreadyNotified: true },
			] satisfies AgentCompleteData[],
			usage,
		});
		expect(xml).toContain('<agent id="a" status="idle" session_id="uuid-1" />');
		expect(xml).toContain('<agent id="b" status="idle" session_id="uuid-2" />');
		expect(xml).not.toContain("out-a");
		expect(xml).not.toContain("out-b");
		expect((xml.match(/<hint>/g) ?? []).length).toBe(1);
		expect(xml).toContain("<usage");
	});

	it("expands entry body for an agent torn down before it notified", () => {
		const xml = serializeGroupTorndown({
			agents: [
				{ id: "a", status: "idle" as const, output: "already-seen", sessionId: "uuid-1", alreadyNotified: true },
				{ id: "b", status: "idle" as const, output: "never-notified", sessionId: "uuid-2", alreadyNotified: false },
			] satisfies AgentCompleteData[],
			usage,
		});
		expect(xml).not.toContain("already-seen");
		expect(xml).toContain("<output>never-notified</output>");
		expect(xml).toContain('<agent id="b" status="idle" session_id="uuid-2">');
		expect(xml).toContain("</agent>");
	});

	it("expands entry body with <error> for failed not-yet-notified agents", () => {
		const xml = serializeGroupTorndown({
			agents: [
				{ id: "a", status: "failed" as const, error: "crashed", sessionId: "uuid-1", alreadyNotified: false },
			] satisfies AgentCompleteData[],
			usage,
		});
		expect(xml).toContain('<agent id="a" status="failed" session_id="uuid-1">');
		expect(xml).toContain("<error>crashed</error>");
	});

	it("omits hint when no agent has a sessionId", () => {
		const xml = serializeGroupTorndown({
			agents: [{ id: "a", status: "idle" as const, alreadyNotified: true }],
			usage,
		});
		expect(xml).not.toContain("session_id=");
		expect(xml).not.toContain("<hint>");
	});
});
