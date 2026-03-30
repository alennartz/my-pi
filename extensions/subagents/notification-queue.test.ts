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
});

// ─── Wait resolution ─────────────────────────────────────────────────────────

describe("NotificationQueue — wait resolution", () => {
	it("resolves when queue() is called during a wait", async () => {
		const { queue } = createQueue();
		queue.setParentBusy(true);
		const p = queue.wait();
		queue.queue('<agent_complete id="a" status="idle"/>', "local");
		const result = await p;
		expect(result).toBe('<agent_complete id="a" status="idle"/>');
	});

	it("includes pre-existing queued notifications in the result", async () => {
		const { queue } = createQueue({ steerDelivery: false });
		queue.setParentBusy(true);
		queue.queue("<event>pre-existing</event>", "local"); // accumulated before wait
		const p = queue.wait();
		queue.queue("<event>trigger</event>", "local"); // triggers resolution
		const result = await p;
		expect(result).toBe("<event>pre-existing</event>\n<event>trigger</event>");
	});

	it("sets isWaiting to true during wait and false after resolution", async () => {
		const { queue } = createQueue();
		queue.setParentBusy(true);
		expect(queue.isWaiting).toBe(false);
		const p = queue.wait();
		expect(queue.isWaiting).toBe(true);
		queue.queue("<event/>", "local");
		await p;
		expect(queue.isWaiting).toBe(false);
	});

	it("does not call deliver during wait — events go to the wait result", async () => {
		const { queue, delivered } = createQueue();
		queue.setParentBusy(true);
		const p = queue.wait();
		queue.queue("<event/>", "local");
		await p;
		expect(delivered).toEqual([]);
	});

	it("suppresses explicit flush() calls while wait is active", () => {
		const { queue, delivered } = createQueue({ steerDelivery: false });
		queue.setParentBusy(true);
		queue.queue("<event>pre</event>", "local"); // accumulated (busy + no steer)
		queue.wait(); // start wait with pre-existing item
		queue.flush(); // explicit flush — suppressed by wait
		expect(delivered).toEqual([]);
	});

	it("suppresses steer delivery auto-flush while wait is active", async () => {
		const { queue, delivered } = createQueue({ steerDelivery: true });
		queue.setParentBusy(true);
		// Steer + no pending tools would normally auto-flush
		const p = queue.wait();
		queue.queue("<event/>", "local");
		const result = await p;
		expect(result).toBe("<event/>");
		expect(delivered).toEqual([]);
	});

	it("resumes normal delivery after wait resolves", async () => {
		const { queue, delivered } = createQueue();
		queue.setParentBusy(true);
		const p = queue.wait();
		queue.queue("<event>trigger</event>", "local");
		await p;
		// Wait resolved — normal delivery should work again
		queue.setParentBusy(false);
		queue.queue("<event>after</event>", "local");
		expect(delivered).toEqual(["<event>after</event>"]);
	});

	it("drains the queue completely on resolution", async () => {
		const { queue } = createQueue({ steerDelivery: false });
		queue.setParentBusy(true);
		queue.queue("<event>pre</event>", "local");
		const p = queue.wait();
		queue.queue("<event>trigger</event>", "local");
		await p;
		expect(queue.length).toBe(0);
	});
});

// ─── Wait immediate resolution ───────────────────────────────────────────────

describe("NotificationQueue — wait immediate resolution", () => {
	it("resolves immediately when isAlreadySatisfied returns true", async () => {
		const { queue } = createQueue({ steerDelivery: false });
		queue.setParentBusy(true);
		queue.queue("<event>pre</event>", "local");
		const result = await queue.wait({ isAlreadySatisfied: () => true });
		expect(result).toBe("<event>pre</event>");
	});

	it("resolves with empty string when already satisfied and queue is empty", async () => {
		const { queue } = createQueue();
		queue.setParentBusy(true);
		const result = await queue.wait({ isAlreadySatisfied: () => true });
		expect(result).toBe("");
	});

	it("isWaiting is false after immediate resolution", async () => {
		const { queue } = createQueue();
		queue.setParentBusy(true);
		await queue.wait({ isAlreadySatisfied: () => true });
		expect(queue.isWaiting).toBe(false);
	});
});

// ─── Wait cancellation ───────────────────────────────────────────────────────

describe("NotificationQueue — wait cancellation", () => {
	it("rejects the promise when the abort signal fires", async () => {
		const { queue } = createQueue();
		queue.setParentBusy(true);
		const controller = new AbortController();
		const p = queue.wait({ signal: controller.signal });
		controller.abort();
		await expect(p).rejects.toThrow();
	});

	it("clears isWaiting on cancellation", async () => {
		const { queue } = createQueue();
		queue.setParentBusy(true);
		const controller = new AbortController();
		const p = queue.wait({ signal: controller.signal });
		controller.abort();
		try {
			await p;
		} catch {
			// expected
		}
		expect(queue.isWaiting).toBe(false);
	});

	it("resumes normal delivery after cancellation", async () => {
		const { queue, delivered } = createQueue();
		queue.setParentBusy(true);
		const controller = new AbortController();
		const p = queue.wait({ signal: controller.signal });
		controller.abort();
		try {
			await p;
		} catch {
			// expected
		}
		queue.setParentBusy(false);
		queue.queue("<event>after-cancel</event>", "local");
		expect(delivered).toEqual(["<event>after-cancel</event>"]);
	});

	it("rejects immediately when given an already-aborted signal", async () => {
		const { queue } = createQueue();
		queue.setParentBusy(true);
		const controller = new AbortController();
		controller.abort();
		const p = queue.wait({ signal: controller.signal });
		await expect(p).rejects.toThrow();
		expect(queue.isWaiting).toBe(false);
	});
});

// ─── Wait error cases ────────────────────────────────────────────────────────

describe("NotificationQueue — wait errors", () => {
	it("throws when a wait is already active", () => {
		const { queue } = createQueue();
		queue.setParentBusy(true);
		queue.wait(); // first wait
		expect(() => queue.wait()).toThrow();
	});
});

// ─── drainLocal / clear ──────────────────────────────────────────────────────

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
