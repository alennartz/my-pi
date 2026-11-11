import { describe, expect, it } from "vitest";
import { createAwaitGate, type AwaitChildStatus, type AwaitMessage } from "./await-gating.js";

const worker = ["worker"] as const;

function idle(output: string): AwaitChildStatus {
	return { path: worker, state: "idle", output, sessionId: "session-worker" };
}

function message(content: string): AwaitMessage {
	return {
		from: ["worker"],
		to: [],
		content,
		correlationId: "corr-1",
		responseExpected: false,
	};
}

describe("view-aware await gating", () => {
	it("holds an idle answer while a child view is attached and coalesces to the latest answer", async () => {
		const gate = createAwaitGate({ requested: [worker], attached: [worker] });
		gate.settle(idle("first answer"));
		gate.settle(idle("latest answer"));

		let resolved = false;
		void gate.result.then(() => {
			resolved = true;
		});
		await Promise.resolve();
		expect(resolved).toBe(false);

		gate.detach(worker);
		await expect(gate.result).resolves.toEqual({
			kind: "released",
			reason: "detach",
			statuses: [idle("latest answer")],
		});
	});

	it("interrupts immediately when a child or peer sends a message, even while its view remains open", async () => {
		const gate = createAwaitGate({ requested: [worker], attached: [worker] });
		gate.settle(idle("held answer"));
		gate.message(message("The callback owner is the session store."));

		await expect(gate.result).resolves.toEqual({
			kind: "interrupted",
			message: message("The callback owner is the session store."),
			statuses: [idle("held answer")],
		});
	});

	it("releases a settled status when the final view detaches", async () => {
		const gate = createAwaitGate({ requested: [worker], attached: [worker] });
		gate.settle({ path: worker, state: "errored", error: "provider timeout", sessionId: "session-worker" });

		gate.detach(worker);
		await expect(gate.result).resolves.toMatchObject({
			kind: "released",
			reason: "detach",
			statuses: [{ path: worker, state: "errored", error: "provider timeout" }],
		});
	});

	it("stops the wait without delivering a held idle answer", async () => {
		const gate = createAwaitGate({ requested: [worker], attached: [worker] });
		gate.settle(idle("held answer"));
		gate.stop();

		await expect(gate.result).resolves.toEqual({
			kind: "released",
			reason: "stop",
			statuses: [],
		});
	});
});
