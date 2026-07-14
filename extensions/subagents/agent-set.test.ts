import { describe, it, expect, vi, beforeEach } from "vitest";
import { SubagentManager } from "./agent-set.js";
import type { AgentStatus } from "./agent-set.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeStatus(overrides: Partial<AgentStatus> = {}): AgentStatus {
	return {
		id: "test-agent",
		state: "running",
		task: "test task",
		channels: ["parent"],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		pendingCorrelations: [],
		lastTurnInput: 0,
		hasSubgroup: false,
		waitingFor: [],
		...overrides,
	};
}

function makeEntry(overrides: Partial<Record<string, any>> = {}): any {
	return {
		id: "test-agent",
		agentDef: undefined,
		task: "test task",
		channels: ["parent"],
		rpc: { stderr: "", exitCode: null },
		status: makeStatus(),
		kind: "agent",
		completionNotified: false,
		agentStartedSinceLastPrompt: false,
		...overrides,
	};
}

function createManager() {
	const onUpdate = vi.fn();
	const onAgentComplete = vi.fn();
	const onParentMessage = vi.fn();
	const agentIdled = vi.fn();

	const mgr = new SubagentManager({
		pi: {} as any,
		cwd: "/tmp",
		skillPaths: new Map(),
		resolveContextWindow: () => undefined,
		onUpdate,
		onAgentComplete,
		onParentMessage,
	});

	// Inject a mock broker so agentIdled calls are trackable.
	(mgr as any).broker = { agentIdled, isQuiet: () => true };

	return { mgr, onUpdate, onAgentComplete, agentIdled };
}

function fireEvent(mgr: SubagentManager, entry: any, event: Record<string, any>): void {
	(mgr as any).handleRpcEvent(entry, event);
}

const errorNotify = (message = "quota soft cap exceeded") => ({
	type: "extension_ui_request",
	method: "notify",
	notifyType: "error",
	message,
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("error-level notify before agent_start", () => {
	it("settles the entry as failed with the notify message as lastError", () => {
		const { mgr, onUpdate, onAgentComplete, agentIdled } = createManager();
		const entry = makeEntry({ agentStartedSinceLastPrompt: false });
		(mgr as any).entries = [entry];

		fireEvent(mgr, entry, errorNotify("quota soft cap exceeded: spending at Jul 19's budget"));

		expect(entry.status.state).toBe("failed");
		expect(entry.status.lastError).toBe("quota soft cap exceeded: spending at Jul 19's budget");
		expect(entry.status.lastActivity).toBeUndefined();
		expect(agentIdled).toHaveBeenCalledWith("test-agent");
		expect(onUpdate).toHaveBeenCalled();
		expect(entry.completionNotified).toBe(true);
		expect(onAgentComplete).toHaveBeenCalledWith(mgr, "test-agent", true);
	});

	it("does not settle if state is not running", () => {
		// Sanity: the 'not running' branch calls agentIdled but does not settle.
		const { mgr, agentIdled } = createManager();
		const entry = makeEntry({
			agentStartedSinceLastPrompt: false,
			status: makeStatus({ state: "idle" }),
		});
		(mgr as any).entries = [entry];

		fireEvent(mgr, entry, errorNotify());

		expect(entry.status.state).toBe("idle");
		expect(entry.status.lastError).toBeUndefined();
		expect(agentIdled).toHaveBeenCalledWith("test-agent");
	});
});

describe("error-level notify after agent_start", () => {
	it("is ignored — agents may legitimately emit error notifies mid-run", () => {
		const { mgr, onUpdate, onAgentComplete, agentIdled } = createManager();
		const entry = makeEntry({ agentStartedSinceLastPrompt: true });
		(mgr as any).entries = [entry];

		fireEvent(mgr, entry, errorNotify("something went wrong mid-run"));

		expect(entry.status.state).toBe("running");
		expect(entry.status.lastError).toBeUndefined();
		expect(entry.completionNotified).toBe(false);
		expect(agentIdled).not.toHaveBeenCalled();
		expect(onUpdate).not.toHaveBeenCalled();
		expect(onAgentComplete).not.toHaveBeenCalled();
	});

	it("agentStartedSinceLastPrompt is set to true by agent_start event", () => {
		const { mgr } = createManager();
		const entry = makeEntry({ agentStartedSinceLastPrompt: false });
		(mgr as any).entries = [entry];

		fireEvent(mgr, entry, { type: "agent_start" });

		expect(entry.agentStartedSinceLastPrompt).toBe(true);
		expect(entry.status.state).toBe("running");
	});
});

describe("error-level notify to an idle entry", () => {
	it("calls agentIdled so pending blocking sends fail fast", () => {
		const { mgr, agentIdled, onAgentComplete } = createManager();
		const entry = makeEntry({
			status: makeStatus({ state: "idle" }),
			agentStartedSinceLastPrompt: false,
		});
		(mgr as any).entries = [entry];

		fireEvent(mgr, entry, errorNotify("input blocked"));

		expect(agentIdled).toHaveBeenCalledWith("test-agent");
		// Entry stays idle — not re-settled as failed.
		expect(entry.status.state).toBe("idle");
		expect(onAgentComplete).not.toHaveBeenCalled();
	});
});

describe("agentStartedSinceLastPrompt reset on agent_end idle", () => {
	it("resets to false when agent ends cleanly so the next prompt starts clean", () => {
		const { mgr } = createManager();
		const entry = makeEntry({ agentStartedSinceLastPrompt: true });
		(mgr as any).entries = [entry];

		fireEvent(mgr, entry, { type: "agent_end", messages: [] });

		expect(entry.agentStartedSinceLastPrompt).toBe(false);
		expect(entry.status.state).toBe("idle");
	});
});
