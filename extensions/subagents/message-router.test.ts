import { describe, expect, it, vi } from "vitest";
import { buildTopology } from "./channels.js";
import { MessageRouter } from "./message-router.js";

function makeRouter(agentIds = ["worker"]): MessageRouter {
	return new MessageRouter({
		topology: buildTopology(
			agentIds.map((id) => ({
				id,
				channels: agentIds.filter((peer) => peer !== id),
			})),
		),
	});
}

describe("MessageRouter connection and fire-and-forget delivery", () => {
	it("connects a parent-local endpoint and delivers messages to the subscribed target", async () => {
		const router = makeRouter();
		const parent = router.connect("parent");
		const worker = router.connect("worker");
		const received: unknown[] = [];
		worker.subscribe((message) => received.push(message));

		const receipt = await parent.send({
			to: "worker",
			message: "hello",
			expectResponse: false,
		});

		expect(receipt.correlationId).toBeUndefined();
		expect(received).toEqual([{
			from: "parent",
			message: "hello",
			responseExpected: false,
		}]);
	});

	it("keeps each connected port scoped to its own endpoint id", () => {
		const router = makeRouter(["alice", "bob"]);
		expect(router.connect("alice").id).toBe("alice");
		expect(router.connect("bob").id).toBe("bob");
		expect(router.connect("parent").id).toBe("parent");
	});
});

describe("MessageRouter blocking correlations", () => {
	it("installs a blocking correlation before an immediate response can arrive", async () => {
		const router = makeRouter();
		const parent = router.connect("parent");
		const worker = router.connect("worker");
		worker.subscribe((message) => {
			if (message.responseExpected && message.correlationId) {
				void worker.respond(message.correlationId, "done");
			}
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

	it("resolves the original sender when the target responds later", async () => {
		const router = makeRouter();
		const parent = router.connect("parent");
		const worker = router.connect("worker");
		const receipt = await parent.send({
			to: "worker",
			message: "question",
			expectResponse: true,
			correlationId: "corr-late",
		});

		await worker.respond("corr-late", "answer");
		await expect(receipt.response).resolves.toEqual({ type: "response", message: "answer" });
	});

	it("rejects an unauthorized target without leaving a pending correlation", async () => {
		const router = makeRouter();
		const parent = router.connect("parent");

		await expect(parent.send({
			to: "not-in-topology",
			message: "blocked",
			expectResponse: true,
			correlationId: "corr-unauthorized",
		})).rejects.toThrow(/channel|authorized|target/i);
		expect(router.isQuiet()).toBe(true);
	});

	it("rejects a blocking send that would close a deadlock cycle before delivery", async () => {
		const router = makeRouter(["alice", "bob"]);
		const alice = router.connect("alice");
		const bob = router.connect("bob");
		const receivedByBob = vi.fn();
		bob.subscribe((message) => receivedByBob(message));

		const first = await alice.send({
			to: "bob",
			message: "first",
			expectResponse: true,
			correlationId: "corr-cycle-a",
		});
		await expect(bob.send({
			to: "alice",
			message: "reverse",
			expectResponse: true,
			correlationId: "corr-cycle-b",
		})).rejects.toThrow(/deadlock|cycle/i);
		expect(receivedByBob).toHaveBeenCalledTimes(1);
		bob.respond("corr-cycle-a", "ok");
		await expect(first.response).resolves.toEqual({ type: "response", message: "ok" });
	});
});

describe("MessageRouter cancellation and detachment", () => {
	it("cancels a blocking correlation so a late response is not delivered", async () => {
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
		await worker.respond("corr-cancel", "too late");
		await expect(receipt.response).rejects.toThrow(/cancel|pending|available/i);
		expect(router.isQuiet()).toBe(true);
	});

	it("detaches the waiting edge while preserving a late response correlation", async () => {
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
		await worker.respond("corr-detach", "late answer");
		await expect(receipt.response).resolves.toEqual({ type: "response", message: "late answer" });
		expect(router.isQuiet()).toBe(true);
	});
});

describe("MessageRouter endpoint lifecycle", () => {
	it("fails sends waiting on a target that becomes idle while keeping that endpoint reusable", async () => {
		const router = makeRouter();
		const parent = router.connect("parent");
		const worker = router.connect("worker");
		const waiting = await parent.send({
			to: "worker",
			message: "finish",
			expectResponse: true,
			correlationId: "corr-idle",
		});

		router.agentIdle("worker");
		await expect(waiting.response).rejects.toThrow(/idle|respond/i);

		await parent.send({ to: "worker", message: "again", expectResponse: false });
		expect(worker.id).toBe("worker");
	});

	it("tombstones an unavailable runtime and reports the supplied error", async () => {
		const router = makeRouter();
		const parent = router.connect("parent");
		router.agentUnavailable("worker", "runtime failed");

		await expect(parent.send({
			to: "worker",
			message: "retry",
			expectResponse: false,
		})).rejects.toThrow(/runtime failed|unavailable|failed/i);
	});

	it("rejects sends to a removed agent", async () => {
		const router = makeRouter();
		const parent = router.connect("parent");
		router.agentRemoved("worker");

		await expect(parent.send({
			to: "worker",
			message: "retry",
			expectResponse: false,
		})).rejects.toThrow(/removed/i);
	});

	it("closes unresolved correlations and removes endpoint subscriptions", async () => {
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

		router.close();
		await expect(waiting.response).rejects.toThrow();
		await expect(parent.send({ to: "worker", message: "after close", expectResponse: false })).rejects.toThrow();
		expect(listener).not.toHaveBeenCalled();
	});
});
