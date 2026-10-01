import { describe, expect, it, vi } from "vitest";
import sessionResumeExtension from "./index.ts";

type Handler = (event: unknown, ctx: any) => void | Promise<void>;

function setup(branch: any[]) {
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
	};
	sessionResumeExtension(pi as any);

	return {
		pi,
		sessionStart: handlers.get("session_start")!,
		ctx: {
			sessionManager: {
				getSessionFile: () => "/tmp/session.jsonl",
				getEntries: () => branch,
				getBranch: () => branch,
			},
		},
	};
}

const idleMarker = { type: "custom", customType: "session-idle" };

describe("session resume", () => {
	it.each([
		{ prefix: "!", excludeFromContext: false },
		{ prefix: "!!", excludeFromContext: true },
	])("does not resume after interrupted user bash command ($prefix)", async ({ excludeFromContext }) => {
		const { pi, sessionStart, ctx } = setup([
			idleMarker,
			{
				type: "message",
				message: {
					role: "bashExecution",
					command: "sleep 30",
					output: "",
					cancelled: true,
					excludeFromContext,
				},
			},
		]);

		await sessionStart({}, ctx);

		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("still resumes when an actual user message follows the idle marker", async () => {
		const { pi, sessionStart, ctx } = setup([
			idleMarker,
			{ type: "message", message: { role: "user", content: "continue" } },
		]);

		await sessionStart({}, ctx);

		expect(pi.sendMessage).toHaveBeenCalledWith(
			{ customType: "session-resumed", content: "[session resumed]", display: false },
			{ triggerTurn: true },
		);
	});
});
