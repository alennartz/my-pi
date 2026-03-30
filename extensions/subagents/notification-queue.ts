/**
 * Notification queue with wait support for await_agents.
 *
 * Manages notification accumulation, delivery timing, and wait resolution
 * for the subagents extension. Extracted from inline closures in index.ts
 * to provide a testable component boundary.
 *
 * Delivery modes:
 * - Idle: auto-flush on queue() (goes through prompt() path)
 * - Busy, steer off: accumulate, flush on agent_end
 * - Busy, steer on, tools running: accumulate, flush when last tool ends
 * - Busy, steer on, LLM streaming: auto-flush on queue()
 *
 * Wait mode (await_agents):
 * - Suppresses all normal flush delivery
 * - queue() resolves the wait promise instead of flushing
 * - Resolution drains the full queue and returns concatenated XML
 */

export type NotificationSource = "local" | "uplink";

export interface NotificationQueueConfig {
	/**
	 * Called to deliver accumulated notifications to the parent agent.
	 * Receives the combined XML content of all queued notifications.
	 */
	deliver: (content: string) => void;

	/**
	 * Use steer delivery mode: flush between tool call rounds instead of
	 * only on agent_end. When true, notifications flush when the last
	 * in-flight tool call ends. When false, they accumulate until agent_end.
	 */
	steerDelivery: boolean;
}

export interface WaitOptions {
	/**
	 * Checked once at wait start. If it returns true, the wait resolves
	 * immediately with any queued content (e.g., all scoped agents are
	 * already idle/failed). If false or omitted, the wait blocks until
	 * the next queue() call.
	 */
	isAlreadySatisfied?: () => boolean;

	/**
	 * Abort signal for cancellation. When the signal fires, the wait
	 * promise rejects and normal delivery resumes. Supports pre-aborted
	 * signals (rejects immediately).
	 */
	signal?: AbortSignal;
}

export class NotificationQueue {
	constructor(private config: NotificationQueueConfig) {}

	/**
	 * Add a notification to the queue.
	 *
	 * Behavior depends on current state:
	 * - Wait active: pushes to queue, then resolves the wait promise
	 * - Not busy: auto-flushes (immediate delivery)
	 * - Busy + steer + no tools: auto-flushes (LLM streaming)
	 * - Busy + steer + tools pending: accumulates (batch for tool end)
	 * - Busy + no steer: accumulates (batch for agent_end)
	 */
	queue(_xml: string, _source: NotificationSource): void {
		throw new Error("Not implemented");
	}

	/**
	 * Attempt to deliver accumulated notifications via the deliver callback.
	 *
	 * Suppressed when:
	 * - Queue is empty
	 * - A wait is active (wait suppression)
	 * - parentBusy is true and steerDelivery is false
	 *
	 * When delivering: sets parentBusy=true synchronously before calling
	 * deliver, preventing a double-flush race between sendMessage and
	 * the subsequent agent_start event.
	 */
	flush(): void {
		throw new Error("Not implemented");
	}

	/** Remove local-source notifications from the queue, preserving uplink entries. */
	drainLocal(): void {
		throw new Error("Not implemented");
	}

	/** Remove all notifications from the queue. */
	clear(): void {
		throw new Error("Not implemented");
	}

	/**
	 * Update the parent agent's busy state.
	 * When set to false, automatically attempts to flush queued notifications.
	 */
	setParentBusy(_busy: boolean): void {
		throw new Error("Not implemented");
	}

	/** Record a tool call starting (for steer delivery batching). */
	trackToolStart(_toolCallId: string): void {
		throw new Error("Not implemented");
	}

	/**
	 * Record a tool call ending. When the last tracked tool call completes,
	 * attempts to flush queued notifications (subject to normal suppression rules).
	 */
	trackToolEnd(_toolCallId: string): void {
		throw new Error("Not implemented");
	}

	/** Clear all tracked tool calls without triggering a flush. */
	clearPendingTools(): void {
		throw new Error("Not implemented");
	}

	/**
	 * Block until a notification arrives or the condition is already met.
	 *
	 * While waiting, all normal flush delivery is suppressed. The queue
	 * accumulates notifications, and the first queue() call during the
	 * wait triggers resolution: the queue is drained and its concatenated
	 * XML content is returned as the promise result.
	 *
	 * If isAlreadySatisfied returns true at call time, resolves immediately
	 * with any queued content (which may be empty).
	 *
	 * Throws synchronously if a wait is already active.
	 */
	wait(_opts?: WaitOptions): Promise<string> {
		throw new Error("Not implemented");
	}

	/** Whether a wait is currently active. */
	get isWaiting(): boolean {
		throw new Error("Not implemented");
	}

	/** Number of currently queued notifications. */
	get length(): number {
		throw new Error("Not implemented");
	}
}
