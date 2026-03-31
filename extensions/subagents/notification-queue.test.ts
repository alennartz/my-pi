import { describe, it, expect } from "vitest";
import { NotificationQueue, type NotificationQueueConfig } from "./notification-queue.js";

function createQueue(overrides?: Partial<NotificationQueueConfig>) {
	const delivered: string[] = [];
	const queue = new NotificationQueue({
		deliver: (content) => delivered.push(content),
		steerDelivery: false,
		...overrides,
	});
	return { queue, delivered };
}

// ─── Normal delivery ─────────────────────────────────────────────────────────

describe("NotificationQueue — normal delivery", () => {
	it("auto-flushes when parent is not busy", () => {
		const { queue, delivered } = createQueue();
		queue.queue("<event>a</event>", "local");
		expect(delivered).toEqual(["<event>a</event>"]);
	});

	it("combines multiple queued notifications into a single delivery", () => {
		const { queue, delivered } = createQueue();
		queue.setParentBusy(true);
		queue.queue("<event>a</event>", "local");
		queue.queue("<event>b</event>", "local");
		queue.setParentBusy(false);
		expect(delivered).toEqual(["<event>a</event>\n<event>b</event>"]);
	});

	it("flush is a no-op when queue is empty", () => {
		const { queue, delivered } = createQueue();
		queue.flush();
		expect(delivered).toEqual([]);
	});

	it("flush empties the queue after delivery", () => {
		const { queue } = createQueue();
		queue.setParentBusy(true);
		queue.queue("<event>a</event>", "local");
		expect(queue.length).toBe(1);
		queue.setParentBusy(false); // triggers flush
		expect(queue.length).toBe(0);
	});

	it("suppresses flush when parent is busy and steer delivery is off", () => {
		const { queue, delivered } = createQueue({ steerDelivery: false });
		queue.setParentBusy(true);
		queue.queue("<event>a</event>", "local");
		queue.flush(); // explicit call — suppressed
		expect(delivered).toEqual([]);
		expect(queue.length).toBe(1);
	});

	it("sets parentBusy before delivering to prevent double-flush race", () => {
		const { queue, delivered } = createQueue();
		// parentBusy starts false
		queue.queue("<event>a</event>", "local"); // auto-flushes, sets parentBusy=true
		queue.queue("<event>b</event>", "local"); // should accumulate (parentBusy now true)
		expect(delivered).toEqual(["<event>a</event>"]);
		expect(queue.length).toBe(1);
	});
});

// ─── Steer delivery ─────────────────────────────────────────────────────────

describe("NotificationQueue — steer delivery", () => {
	it("auto-flushes when busy with no pending tool calls", () => {
		const { queue, delivered } = createQueue({ steerDelivery: true });
		queue.setParentBusy(true);
		queue.queue("<event>a</event>", "local");
		expect(delivered).toEqual(["<event>a</event>"]);
	});

	it("accumulates when tool calls are pending", () => {
		const { queue, delivered } = createQueue({ steerDelivery: true });
		queue.setParentBusy(true);
		queue.trackToolStart("tool1");
		queue.queue("<event>a</event>", "local");
		expect(delivered).toEqual([]);
		expect(queue.length).toBe(1);
	});

	it("flushes when the last tool call completes", () => {
		const { queue, delivered } = createQueue({ steerDelivery: true });
		queue.setParentBusy(true);
		queue.trackToolStart("tool1");
		queue.queue("<event>a</event>", "local");
		queue.trackToolEnd("tool1");
		expect(delivered).toEqual(["<event>a</event>"]);
	});

	it("does not flush when other tool calls are still pending", () => {
		const { queue, delivered } = createQueue({ steerDelivery: true });
		queue.setParentBusy(true);
		queue.trackToolStart("tool1");
		queue.trackToolStart("tool2");
		queue.queue("<event>a</event>", "local");
		queue.trackToolEnd("tool1");
		expect(delivered).toEqual([]);
		expect(queue.length).toBe(1);
	});

	it("flushes when all concurrent tool calls have completed", () => {
		const { queue, delivered } = createQueue({ steerDelivery: true });
		queue.setParentBusy(true);
		queue.trackToolStart("tool1");
		queue.trackToolStart("tool2");
		queue.queue("<event>a</event>", "local");
		queue.trackToolEnd("tool1");
		queue.trackToolEnd("tool2");
		expect(delivered).toEqual(["<event>a</event>"]);
	});

	it("clearPendingTools does not trigger a flush", () => {
		const { queue, delivered } = createQueue({ steerDelivery: true });
		queue.setParentBusy(true);
		queue.trackToolStart("tool1");
		queue.queue("<event>a</event>", "local");
		queue.clearPendingTools();
		expect(delivered).toEqual([]);
		expect(queue.length).toBe(1);
	});
});

// ─── Waiting flag suppresses delivery ────────────────────────────────────────

describe("NotificationQueue — waiting suppresses delivery", () => {
	it("accumulates without flushing when waiting is set", () => {
		const { queue, delivered } = createQueue();
		queue.setWaiting(true);
		queue.queue("<event>a</event>", "local");
		expect(delivered).toEqual([]);
		expect(queue.length).toBe(1);
	});

	it("suppresses explicit flush() while waiting", () => {
		const { queue, delivered } = createQueue();
		queue.queue("<event>a</event>", "local"); // auto-flushes (not waiting yet)
		queue.setParentBusy(true); // now busy from the flush
		queue.setWaiting(true);
		queue.queue("<event>b</event>", "local");
		queue.flush();
		expect(delivered).toEqual(["<event>a</event>"]); // only the pre-wait one
		expect(queue.length).toBe(1);
	});

	it("suppresses steer delivery auto-flush while waiting", () => {
		const { queue, delivered } = createQueue({ steerDelivery: true });
		queue.setParentBusy(true);
		queue.setWaiting(true);
		// Steer + no pending tools would normally auto-flush
		queue.queue("<event>a</event>", "local");
		expect(delivered).toEqual([]);
		expect(queue.length).toBe(1);
	});

	it("suppresses trackToolEnd flush while waiting", () => {
		const { queue, delivered } = createQueue({ steerDelivery: true });
		queue.setParentBusy(true);
		queue.trackToolStart("tool1");
		queue.setWaiting(true);
		queue.queue("<event>a</event>", "local");
		queue.trackToolEnd("tool1");
		expect(delivered).toEqual([]);
		expect(queue.length).toBe(1);
	});

	it("resumes normal delivery after waiting is cleared", () => {
		const { queue, delivered } = createQueue();
		queue.setWaiting(true);
		queue.queue("<event>a</event>", "local");
		queue.setWaiting(false);
		// Queue doesn't auto-flush on setWaiting(false) — needs a trigger
		queue.queue("<event>b</event>", "local");
		expect(delivered).toEqual(["<event>a</event>\n<event>b</event>"]);
	});
});

// ─── drainAll ────────────────────────────────────────────────────────────────

describe("NotificationQueue — drainAll", () => {
	it("returns concatenated content and empties the queue", () => {
		const { queue } = createQueue();
		queue.setParentBusy(true);
		queue.queue("<event>a</event>", "local");
		queue.queue("<event>b</event>", "local");
		const result = queue.drainAll();
		expect(result).toBe("<event>a</event>\n<event>b</event>");
		expect(queue.length).toBe(0);
	});

	it("returns empty string when queue is empty", () => {
		const { queue } = createQueue();
		expect(queue.drainAll()).toBe("");
	});
});

// ─── drainLocal ──────────────────────────────────────────────────────────────

describe("NotificationQueue — drainLocal", () => {
	it("removes local-source notifications and preserves uplink entries", () => {
		const { queue } = createQueue({ steerDelivery: false });
		queue.setParentBusy(true);
		queue.queue("<local>a</local>", "local");
		queue.queue("<uplink>b</uplink>", "uplink");
		queue.queue("<local>c</local>", "local");
		queue.drainLocal();
		expect(queue.length).toBe(1);
	});
});

// ─── clear ───────────────────────────────────────────────────────────────────

describe("NotificationQueue — clear", () => {
	it("removes all notifications regardless of source", () => {
		const { queue } = createQueue({ steerDelivery: false });
		queue.setParentBusy(true);
		queue.queue("<event>a</event>", "local");
		queue.queue("<event>b</event>", "uplink");
		queue.clear();
		expect(queue.length).toBe(0);
	});
});
