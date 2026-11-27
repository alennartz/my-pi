import { describe, expect, it } from "vitest";
import { NotificationQueue } from "./notification-queue.js";
import type { Notice, NoticeDelivery } from "./notification-queue.js";

function harness() {
	const deliveries: { contents: string[]; mode: NoticeDelivery }[] = [];
	const queue = new NotificationQueue((notices, mode) => deliveries.push({ contents: notices.map((notice) => notice.content), mode }));
	return { queue, deliveries };
}

const message = (content: string): Notice => ({ kind: "message", content });
const completion = (content: string): Notice => ({ kind: "completion", content });
const settle = () => new Promise<void>((resolve) => {
	queueMicrotask(resolve);
});

describe("NotificationQueue", () => {
	it("starts one turn for notices that arrive together while the parent is idle", async () => {
		const { queue, deliveries } = harness();
		queue.queue(completion("a"));
		queue.queue(message("b"));
		await settle();
		expect(deliveries).toEqual([{ contents: ["a", "b"], mode: "trigger" }]);
	});

	it("holds notices during a run and hands them to the next turn boundary", async () => {
		const { queue, deliveries } = harness();
		queue.runStarted();
		queue.queue(completion("a"));
		await settle();
		expect(deliveries).toEqual([]);
		expect(queue.boundary()).toBe(true);
		expect(deliveries).toEqual([{ contents: ["a"], mode: "context" }]);
		expect(queue.boundary()).toBe(false);
	});

	it("parks notices without a turn when the run was aborted", () => {
		const { queue, deliveries } = harness();
		queue.runStarted();
		queue.queue(completion("a"));
		queue.runSettled(true);
		expect(deliveries).toEqual([{ contents: ["a"], mode: "park" }]);
	});

	it("starts a turn for notices left after a normal run", () => {
		const { queue, deliveries } = harness();
		queue.runStarted();
		queue.queue(completion("a"));
		queue.runSettled(false);
		expect(deliveries).toEqual([{ contents: ["a"], mode: "trigger" }]);
	});

	it("keeps notices while a wait is active and lets the wait take what it consumes", async () => {
		const { queue, deliveries } = harness();
		queue.setWaiting(true);
		queue.queue(completion("consumed"));
		queue.queue(message("kept"));
		expect(queue.hasMessages()).toBe(true);
		expect(queue.boundary()).toBe(false);
		expect(queue.take((notice) => notice.kind === "completion").map((notice) => notice.content)).toEqual(["consumed"]);
		queue.setWaiting(false);
		await settle();
		expect(deliveries).toEqual([{ contents: ["kept"], mode: "trigger" }]);
	});
});
