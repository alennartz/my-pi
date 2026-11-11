import { describe, expect, it } from "vitest";
import { createAwaitGate, type AwaitChildStatus, type AwaitMessage } from "./await-gating.js";

const worker = ["worker"] as const;
const scout = ["scout"] as const;

function idle(output: string, path: readonly string[] = worker): AwaitChildStatus {
	return { path, state: "idle", output, sessionId: `session-${path.join("-")}` };
}

function message(content: string): AwaitMessage {
	return { from: scout, to: [], content, correlationId: "corr-1", responseExpected: false };
}

async function expectPending(promise: Promise<unknown>): Promise<void> {
	let resolved = false;
	void promise.then(() => { resolved = true; });
	await Promise.resolve();
	expect(resolved).toBe(false);
}

function observeDelivery() {
	const statuses: AwaitChildStatus[] = [];
	let resolve!: (status: AwaitChildStatus) => void;
	const delivered = new Promise<AwaitChildStatus>((next) => { resolve = next; });
	return {
		statuses,
		delivered,
		onDelivery(status: AwaitChildStatus) { statuses.push(status); resolve(status); },
	};
}

describe("view-aware await gating", () => {
	it("releases normally when all requested children settle without leases", async () => {
		const gate = createAwaitGate({ requested: [worker, scout] });
		gate.settle(idle("worker answer"));
		await expectPending(gate.result);
		gate.settle(idle("scout answer", scout));

		await expect(gate.result).resolves.toMatchObject({
			kind: "released", reason: "settled",
			statuses: expect.arrayContaining([idle("worker answer"), idle("scout answer", scout)]),
		});
	});

	it("waits for every requested child in a larger group", async () => {
		const paths = Array.from({ length: 32 }, (_, index) => [`child-${index}`]);
		const gate = createAwaitGate({ requested: paths });
		for (const path of paths.slice(0, -1)) gate.settle(idle(`answer-${path[0]}`, path));
		await expectPending(gate.result);
		gate.settle(idle("last answer", paths[31]));

		const outcome = await gate.result;
		expect(outcome.kind).toBe("released");
		expect(outcome.statuses.map((status) => status.path)).toEqual(expect.arrayContaining(paths));
		expect(outcome.statuses).toHaveLength(paths.length);
	});

	it("holds and delivers only the latest idle answer on final detach", async () => {
		const delivery = observeDelivery();
		const gate = createAwaitGate({ requested: [worker], attached: [worker, worker], onHeldIdleDelivery: delivery.onDelivery });
		gate.settle(idle("first answer"));
		gate.settle(idle("latest answer"));
		gate.detach(worker);
		await expectPending(gate.result);
		await expectPending(delivery.delivered);

		gate.detach(worker);
		await expect(gate.result).resolves.toMatchObject({ kind: "released", reason: "detach", statuses: [idle("latest answer")] });
		await expect(delivery.delivered).resolves.toEqual(idle("latest answer"));
		expect(delivery.statuses).toEqual([idle("latest answer")]);
	});

	it("holds the latest idle notification without an active await until the final detach", async () => {
		const delivery = observeDelivery();
		const gate = createAwaitGate({ requested: [], attached: [worker, worker], onHeldIdleDelivery: delivery.onDelivery });
		await expect(gate.result).resolves.toMatchObject({ kind: "released", reason: "settled", statuses: [] });
		gate.settle(idle("first answer"));
		gate.settle(idle("latest answer"));
		gate.detach(worker);
		await expectPending(delivery.delivered);

		gate.detach(worker);
		await expect(delivery.delivered).resolves.toEqual(idle("latest answer"));
		expect(delivery.statuses).toEqual([idle("latest answer")]);
	});

	it("counts later attachments and waits for all requested children", async () => {
		const gate = createAwaitGate({ requested: [worker, scout], attached: [worker] });
		gate.attach(worker);
		gate.attach(scout);
		gate.settle(idle("worker answer"));
		gate.settle(idle("scout answer", scout));
		gate.detach(worker);
		gate.detach(scout);
		await expectPending(gate.result);
		gate.detach(worker);

		await expect(gate.result).resolves.toMatchObject({
			kind: "released",
			statuses: expect.arrayContaining([idle("worker answer"), idle("scout answer", scout)]),
		});
	});

	it("still waits for a running child after the view detaches", async () => {
		const gate = createAwaitGate({ requested: [worker], attached: [worker] });
		gate.detach(worker);
		await expectPending(gate.result);
		gate.settle(idle("answer"));
		await expect(gate.result).resolves.toMatchObject({ kind: "released", statuses: [idle("answer")] });
	});

	it.each(["errored", "dead"] as const)("holds a %s status until the final detach", async (state) => {
		const status: AwaitChildStatus = { path: worker, state, error: "runtime unavailable", sessionId: "session-worker" };
		const gate = createAwaitGate({ requested: [worker], attached: [worker] });
		gate.settle(status);
		await expectPending(gate.result);
		gate.detach(worker);
		await expect(gate.result).resolves.toMatchObject({ kind: "released", statuses: [status] });
	});

	it.each([worker, scout])("interrupts on a message from %j while the view is open and delivers held idle on detach", async (from) => {
		const delivery = observeDelivery();
		const gate = createAwaitGate({ requested: [worker], attached: [worker], onHeldIdleDelivery: delivery.onDelivery });
		gate.settle(idle("held answer"));
		const incoming = { ...message("The callback owner is the session store."), from };
		gate.message(incoming);

		await expect(gate.result).resolves.toMatchObject({ kind: "interrupted", message: incoming });
		await expectPending(delivery.delivered);
		gate.detach(worker);
		await expect(delivery.delivered).resolves.toEqual(idle("held answer"));
		expect(delivery.statuses).toEqual([idle("held answer")]);
	});

	it("stops held notifications without an active await", async () => {
		const delivery = observeDelivery();
		const gate = createAwaitGate({ requested: [], attached: [worker], onHeldIdleDelivery: delivery.onDelivery });
		await expect(gate.result).resolves.toMatchObject({ kind: "released", reason: "settled", statuses: [] });
		gate.settle(idle("held answer"));
		gate.stop();
		gate.detach(worker);
		await expectPending(delivery.delivered);
	});

	it("stops the wait and never delivers a held idle answer on detach", async () => {
		const delivery = observeDelivery();
		const gate = createAwaitGate({ requested: [worker], attached: [worker], onHeldIdleDelivery: delivery.onDelivery });
		gate.settle(idle("held answer"));
		gate.stop();

		const outcome = await gate.result;
		expect(outcome).toMatchObject({ kind: "released", reason: "stop" });
		expect(outcome.statuses.some((status) => status.output === "held answer")).toBe(false);
		gate.detach(worker);
		await expectPending(delivery.delivered);
	});
});
