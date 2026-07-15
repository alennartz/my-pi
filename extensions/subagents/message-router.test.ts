import { describe, expect, it, vi } from "vitest";
import { buildTopology } from "./channels.js";
import { MessageRouter } from "./message-router.js";

function makeRouter(
	agentIds = ["worker"],
	overrides: Partial<ConstructorParameters<typeof MessageRouter>[0]> = {},
): MessageRouter {
	return new MessageRouter({
		topology: buildTopology(
			agentIds.map((id) => ({
				id,
				channels: agentIds.filter((peer) => peer !== id),
			})),
		),
		...overrides,
	});
}

describe("MessageRouter endpoint delivery", () => {
	it("delivers fire-and-forget messages in both directions and honors unsubscribe", async () => {
		const router = makeRouter();
		const parent = router.connect("parent");
		const worker = router.connect("worker");
		const workerMessages: unknown[] = [];
		const parentMessages: unknown[] = [];
		const unsubscribe = worker.subscribe((message) => workerMessages.push(message));
		parent.subscribe((message) => parentMessages.push(message));

		await parent.send({ to: "worker", message: "hello", expectResponse: false });
		await worker.send({ to: "parent", message: "question", expectResponse: false });
		unsubscribe();
		await parent.send({ to: "worker", message: "after unsubscribe", expectResponse: false });

		expect(workerMessages).toEqual([{
			from: "parent",
			message: "hello",
			responseExpected: false,
		}]);
		expect(parentMessages).toEqual([{
			from: "worker",
			message: "question",
			responseExpected: false,
		}]);
	});

	it("rejects connections from endpoints outside the parent-local topology", () => {
		const router = makeRouter();
		expect(() => router.connect("not-a-child")).toThrow(/unknown|topology|endpoint/i);
	});
});

describe("MessageRouter blocking correlations", () => {
	it("installs a correlation before immediate delivery and response", async () => {
		const router = makeRouter();
		const parent = router.connect("parent");
		const worker = router.connect("worker");
		worker.subscribe((message) => {
			if (message.correlationId) void worker.respond(message.correlationId, "done");
		});

		const receipt = await parent.send({
			to: "worker",
			message: "question",
			expectResponse: true,
			correlationId: "corr-immediate",
		});

		expect(receipt.correlationId).toBe("corr-immediate");
		await expect(receipt.response).resolves.toEqual({ type: "response", message: "done" });
		expect(router.isQuiet()).toBe(true);
	});

	it("allocates an omitted correlation id and exposes it to the responder", async () => {
		const router = makeRouter();
		const parent = router.connect("parent");
		const worker = router.connect("worker");
		let deliveredCorrelationId: string | undefined;
		worker.subscribe((message) => {
			deliveredCorrelationId = message.correlationId;
		});

		const receipt = await parent.send({ to: "worker", message: "question", expectResponse: true });
		expect(receipt.correlationId).toEqual(expect.any(String));
		expect(deliveredCorrelationId).toBe(receipt.correlationId);
		await worker.respond(receipt.correlationId!, "answer");
		await expect(receipt.response).resolves.toEqual({ type: "response", message: "answer" });
	});

	it("rejects duplicate caller-supplied correlations without delivering a second message", async () => {
		const router = makeRouter();
		const parent = router.connect("parent");
		const worker = router.connect("worker");
		const listener = vi.fn();
		worker.subscribe(listener);
		const first = await parent.send({
			to: "worker",
			message: "first",
			expectResponse: true,
			correlationId: "corr-duplicate",
		});

		await expect(parent.send({
			to: "worker",
			message: "second",
			expectResponse: true,
			correlationId: "corr-duplicate",
		})).rejects.toThrow(/duplicate|correlation|pending/i);
		expect(listener).toHaveBeenCalledTimes(1);
		await worker.respond("corr-duplicate", "first answer");
		await expect(first.response).resolves.toEqual({ type: "response", message: "first answer" });
	});

	it("rejects unauthorized and disconnected targets before allocating a correlation", async () => {
		const unauthorizedRouter = makeRouter();
		const unauthorizedParent = unauthorizedRouter.connect("parent");
		await expect(unauthorizedParent.send({
			to: "not-in-topology",
			message: "blocked",
			expectResponse: true,
			correlationId: "corr-unauthorized",
		})).rejects.toThrow(/channel|authorized|target/i);
		expect(unauthorizedRouter.isQuiet()).toBe(true);

		const disconnectedRouter = makeRouter();
		const disconnectedParent = disconnectedRouter.connect("parent");
		await expect(disconnectedParent.send({
			to: "worker",
			message: "not connected",
			expectResponse: true,
			correlationId: "corr-disconnected",
		})).rejects.toThrow(/connected|unavailable|target/i);
		expect(disconnectedRouter.isQuiet()).toBe(true);
	});

	it("rejects cycles before delivery and preserves active dependency edges", async () => {
		const router = makeRouter(["alice", "bob"]);
		const alice = router.connect("alice");
		const bob = router.connect("bob");
		const receivedByBob = vi.fn();
		bob.subscribe(receivedByBob);
		const first = await alice.send({
			to: "bob",
			message: "first",
			expectResponse: true,
			correlationId: "corr-cycle-a",
		});
		const second = await alice.send({
			to: "bob",
			message: "second",
			expectResponse: true,
			correlationId: "corr-cycle-b",
		});

		await bob.respond("corr-cycle-a", "first answer");
		await expect(first.response).resolves.toEqual({ type: "response", message: "first answer" });
		await expect(bob.send({
			to: "alice",
			message: "reverse",
			expectResponse: true,
			correlationId: "corr-cycle-reverse",
		})).rejects.toThrow(/deadlock|cycle/i);
		expect(receivedByBob).toHaveBeenCalledTimes(2);

		await bob.respond("corr-cycle-b", "second answer");
		await expect(second.response).resolves.toEqual({ type: "response", message: "second answer" });
	});

	it("accepts a response only from the endpoint that received the request", async () => {
		const router = makeRouter(["worker", "intruder"]);
		const parent = router.connect("parent");
		const worker = router.connect("worker");
		const intruder = router.connect("intruder");
		const receipt = await parent.send({
			to: "worker",
			message: "private question",
			expectResponse: true,
			correlationId: "corr-owned",
		});

		await expect(intruder.respond("corr-owned", "hijack")).rejects.toThrow(/target|owner|pending|correlation/i);
		await worker.respond("corr-owned", "real answer");
		await expect(receipt.response).resolves.toEqual({ type: "response", message: "real answer" });
	});
});

describe("MessageRouter cancellation and terminal lifecycle", () => {
	it("returns a typed error for a cancelled accepted wait and rejects the late responder", async () => {
		const router = makeRouter();
		const parent = router.connect("parent");
		const worker = router.connect("worker");
		const receipt = await parent.send({
			to: "worker",
			message: "cancel me",
			expectResponse: true,
			correlationId: "corr-cancel",
		});

		parent.cancel("corr-cancel");
		await expect(receipt.response).resolves.toMatchObject({ type: "error", error: expect.stringMatching(/cancel/i) });
		await expect(worker.respond("corr-cancel", "too late")).rejects.toThrow(/no pending|correlation/i);
		expect(router.isQuiet()).toBe(true);
	});

	it("detaches only the waiting edge, allowing reverse work and a late response", async () => {
		const router = makeRouter();
		const parent = router.connect("parent");
		const worker = router.connect("worker");
		const receipt = await parent.send({
			to: "worker",
			message: "detach me",
			expectResponse: true,
			correlationId: "corr-detach",
		});

		parent.detach("corr-detach");
		expect(router.isQuiet()).toBe(false);
		const reverse = await worker.send({
			to: "parent",
			message: "reverse is no longer deadlocked",
			expectResponse: true,
			correlationId: "corr-reverse",
		});
		await parent.respond("corr-reverse", "acknowledged");
		await expect(reverse.response).resolves.toEqual({ type: "response", message: "acknowledged" });

		await worker.respond("corr-detach", "late answer");
		await expect(receipt.response).resolves.toEqual({ type: "response", message: "late answer" });
		expect(router.isQuiet()).toBe(true);
	});

	it("returns typed errors for idle, unavailable, and removed targets while preserving their distinct reuse rules", async () => {
		const idleRouter = makeRouter();
		const idleParent = idleRouter.connect("parent");
		idleRouter.connect("worker");
		const idleWait = await idleParent.send({
			to: "worker",
			message: "finish",
			expectResponse: true,
			correlationId: "corr-idle",
		});
		idleRouter.agentIdle("worker");
		await expect(idleWait.response).resolves.toMatchObject({ type: "error", error: expect.stringMatching(/idle|respond/i) });
		const repeat = await idleParent.send({ to: "worker", message: "again", expectResponse: false });
		expect(repeat.correlationId).toBeUndefined();

		const unavailableRouter = makeRouter();
		const unavailableParent = unavailableRouter.connect("parent");
		unavailableRouter.connect("worker");
		const unavailableWait = await unavailableParent.send({
			to: "worker",
			message: "finish",
			expectResponse: true,
			correlationId: "corr-unavailable",
		});
		unavailableRouter.agentUnavailable("worker", "runtime failed");
		await expect(unavailableWait.response).resolves.toEqual({ type: "error", error: "runtime failed" });
		await expect(unavailableParent.send({ to: "worker", message: "retry", expectResponse: false })).rejects.toThrow(/runtime failed|unavailable|failed/i);

		const removedRouter = makeRouter();
		const removedParent = removedRouter.connect("parent");
		removedRouter.connect("worker");
		const removedWait = await removedParent.send({
			to: "worker",
			message: "finish",
			expectResponse: true,
			correlationId: "corr-removed",
		});
		removedRouter.agentRemoved("worker");
		await expect(removedWait.response).resolves.toMatchObject({ type: "error", error: expect.stringMatching(/removed/i) });
		await expect(removedParent.send({ to: "worker", message: "retry", expectResponse: false })).rejects.toThrow(/removed/i);

		const resurrectedWorker = removedRouter.connect("worker");
		const received: unknown[] = [];
		resurrectedWorker.subscribe((message) => received.push(message));
		await removedParent.send({ to: "worker", message: "welcome back", expectResponse: false });
		expect(received).toEqual([{
			from: "parent",
			message: "welcome back",
			responseExpected: false,
		}]);
	});

	it("clears correlations owned by a removed sender", async () => {
		const router = makeRouter();
		const parent = router.connect("parent");
		const worker = router.connect("worker");
		const outgoing = await worker.send({
			to: "parent",
			message: "waiting",
			expectResponse: true,
			correlationId: "corr-removed-sender",
		});

		router.agentRemoved("worker");
		await expect(outgoing.response).resolves.toMatchObject({ type: "error", error: expect.stringMatching(/removed/i) });
		await expect(parent.respond("corr-removed-sender", "late")).rejects.toThrow(/no pending|correlation/i);
		expect(router.isQuiet()).toBe(true);
	});

	it("rejects unresolved waits only when the router itself closes", async () => {
		const router = makeRouter();
		const parent = router.connect("parent");
		const worker = router.connect("worker");
		const listener = vi.fn();
		worker.subscribe(listener);
		const waiting = await parent.send({
			to: "worker",
			message: "close me",
			expectResponse: true,
			correlationId: "corr-close",
		});

		expect(listener).toHaveBeenCalledWith({
			from: "parent",
			message: "close me",
			correlationId: "corr-close",
			responseExpected: true,
		});
		router.close();
		await expect(waiting.response).rejects.toThrow(/close|router/i);
		await expect(parent.send({ to: "worker", message: "after close", expectResponse: false })).rejects.toThrow(/close|router/i);
	});
});

describe("MessageRouter blocking-status projection", () => {
	it("starts once and ends once for response, cancellation, detachment, lifecycle failure, and close", async () => {
		const outcomes = ["response", "cancel", "detach", "idle", "unavailable", "removed", "close"] as const;
		for (const outcome of outcomes) {
			const starts = vi.fn();
			const ends = vi.fn();
			const router = makeRouter(["worker"], {
				onBlockingSendStart: starts,
				onBlockingSendEnd: ends,
			});
			const parent = router.connect("parent");
			const worker = router.connect("worker");
			const correlationId = `corr-${outcome}`;
			const receipt = await parent.send({ to: "worker", message: outcome, expectResponse: true, correlationId });
			expect(starts).toHaveBeenCalledExactlyOnceWith("parent", "worker", correlationId);

			switch (outcome) {
				case "response":
					await worker.respond(correlationId, "done");
					await expect(receipt.response).resolves.toEqual({ type: "response", message: "done" });
					break;
				case "cancel":
					parent.cancel(correlationId);
					await expect(receipt.response).resolves.toMatchObject({ type: "error" });
					break;
				case "detach":
					parent.detach(correlationId);
					await worker.respond(correlationId, "late");
					await expect(receipt.response).resolves.toEqual({ type: "response", message: "late" });
					break;
				case "idle":
					router.agentIdle("worker");
					await expect(receipt.response).resolves.toMatchObject({ type: "error" });
					break;
				case "unavailable":
					router.agentUnavailable("worker", "unavailable");
					await expect(receipt.response).resolves.toMatchObject({ type: "error" });
					break;
				case "removed":
					router.agentRemoved("worker");
					await expect(receipt.response).resolves.toMatchObject({ type: "error" });
					break;
				case "close":
					router.close();
					await expect(receipt.response).rejects.toThrow();
					break;
			}
			expect(ends).toHaveBeenCalledExactlyOnceWith("parent", correlationId);
		}
	});
});
