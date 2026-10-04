import { describe, expect, it } from "vitest";
import { isAutoflowInvocation, planInput, shouldArm } from "./trigger.ts";

const COMMAND = "/skill:autoflow";

describe("shouldArm", () => {
	const base = {
		reason: "startup",
		hasPriorMessages: false,
		isSubagentChild: false,
		autoStart: true,
	};

	it("arms for a fresh session with the opt-in enabled", () => {
		expect(shouldArm(base)).toBe(true);
	});

	it.each(["new", "reload"])("arms for reason %s on an empty session", (reason) => {
		expect(shouldArm({ ...base, reason })).toBe(true);
	});

	it("does not arm without the opt-in", () => {
		expect(shouldArm({ ...base, autoStart: false })).toBe(false);
	});

	it("does not arm for a subagent child session", () => {
		expect(shouldArm({ ...base, isSubagentChild: true })).toBe(false);
	});

	it.each(["resume", "fork", "unexpected"])("does not arm for reason %s", (reason) => {
		expect(shouldArm({ ...base, reason })).toBe(false);
	});

	it("does not arm when the session already contains messages", () => {
		expect(shouldArm({ ...base, hasPriorMessages: true })).toBe(false);
	});
});

describe("isAutoflowInvocation", () => {
	it.each([
		"/skill:autoflow build a thing",
		"/skill:autoflow",
		"/autoflow build a thing",
	])("recognizes %s", (text) => {
		expect(isAutoflowInvocation(text, COMMAND)).toBe(true);
	});

	it("recognizes a custom configured command", () => {
		expect(isAutoflowInvocation("/flow now", "/flow")).toBe(true);
	});

	it.each(["/tidy", "autoflow build a thing", "/skill:other thing"])(
		"does not match %s",
		(text) => {
			expect(isAutoflowInvocation(text, COMMAND)).toBe(false);
		},
	);
});

describe("planInput", () => {
	it("rewrites the first plain message into an autoflow invocation with the message appended", () => {
		expect(planInput(true, { text: "build me a thing", command: COMMAND })).toEqual({
			armed: false,
			action: { kind: "transform", text: "/skill:autoflow build me a thing" },
		});
	});

	it("preserves the message verbatim in the rewrite", () => {
		const plan = planInput(true, { text: " fix  the bug ", command: COMMAND });
		expect(plan.action).toEqual({ kind: "transform", text: "/skill:autoflow  fix  the bug " });
	});

	it("uses the configured command", () => {
		const plan = planInput(true, { text: "go", command: "/flow" });
		expect(plan.action).toEqual({ kind: "transform", text: "/flow go" });
	});

	it("passes through without a rewrite when disarmed", () => {
		expect(planInput(false, { text: "hello", command: COMMAND })).toEqual({
			armed: false,
			action: { kind: "pass" },
		});
	});

	it("stays armed across empty input", () => {
		expect(planInput(true, { text: "   ", command: COMMAND })).toEqual({
			armed: true,
			action: { kind: "pass" },
		});
	});

	it("stays armed across bash commands", () => {
		expect(planInput(true, { text: "!git status", command: COMMAND })).toEqual({
			armed: true,
			action: { kind: "pass" },
		});
	});

	it("stays armed across other slash commands", () => {
		expect(planInput(true, { text: "/tidy", command: COMMAND })).toEqual({
			armed: true,
			action: { kind: "pass" },
		});
	});

	it.each(["/skill:autoflow go", "/autoflow go"])(
		"disarms without a rewrite when the user invokes autoflow themselves (%s)",
		(text) => {
			expect(planInput(true, { text, command: COMMAND })).toEqual({
				armed: false,
				action: { kind: "pass" },
			});
		},
	);

	it("disarms without a rewrite for input queued during streaming", () => {
		const plan = planInput(true, { text: "hello", command: COMMAND, streamingBehavior: "steer" });
		expect(plan).toEqual({ armed: false, action: { kind: "pass" } });
	});
});
