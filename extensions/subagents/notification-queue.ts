/**
 * Notification queue for the subagents extension.
 *
 * Manages notification accumulation and delivery timing. The queue
 * stores XML notification strings and flushes them via a deliver
 * callback based on parent busy state, steer delivery mode, and
 * a waiting flag.
 *
 * Delivery modes:
 * - Idle: auto-flush on queue() (goes through prompt() path)
 * - Busy, steer off: accumulate, flush on agent_end
 * - Busy, steer on, tools running: accumulate, flush when last tool ends
 * - Busy, steer on, LLM streaming: auto-flush on queue()
 *
 * When waiting is set, all flush delivery is suppressed. External
 * callers drain the queue themselves via drainAll().
 *
 * An aborted run is the one case where a settled agent must not be woken:
 * the operator asked it to stop. deferAll() hands the accumulated
 * notifications over without starting a turn, so nothing is lost and
 * nothing restarts.
 */

export type NotificationSource = "local" | "uplink";

export interface NotificationQueueConfig {
	/**
	 * Called to deliver accumulated notifications to the parent agent.
	 * Receives the combined XML content of all queued notifications.
	 */
	deliver: (content: string) => void;

	/**
	 * Called to hand notifications to the agent without starting a turn.
	 * Used after an aborted run, where waking the agent would defeat the
	 * interrupt. Delivery happens whenever the agent is next prompted.
	 */
	deliverDeferred: (content: string) => void;

	/**
	 * Use steer delivery mode: flush between tool call rounds instead of
	 * only on agent_end. When true, notifications flush when the last
	 * in-flight tool call ends. When false, they accumulate until agent_end.
	 */
	steerDelivery: boolean;
}

interface QueueEntry {
	xml: string;
	source: NotificationSource;
}

export class NotificationQueue {
	private entries: QueueEntry[] = [];
	private parentBusy = false;
	private pendingToolCalls = new Set<string>();
	private _isWaiting = false;

	constructor(private config: NotificationQueueConfig) {}

	queue(xml: string, source: NotificationSource): void {
		this.entries.push({ xml, source });

		if (this._isWaiting) {
			return;
		}

		if (!this.parentBusy) {
			this.doFlush();
		} else if (this.config.steerDelivery && this.pendingToolCalls.size === 0) {
			this.doFlush();
		}
	}

	flush(): void {
		if (this._isWaiting) return;
		if (this.entries.length === 0) return;
		if (this.parentBusy && !this.config.steerDelivery) return;
		// In steer mode while busy, mirror queue()'s gating: hold until the last
		// in-flight tool call ends so we don't deliver mid-tool-round.
		if (this.parentBusy && this.pendingToolCalls.size > 0) return;

		this.doFlush();
	}

	/**
	 * Drain all entries and return the concatenated XML content.
	 * Empties the queue.
	 */
	drainAll(): string {
		const combined = this.entries.map((e) => e.xml).join("\n");
		this.entries.length = 0;
		return combined;
	}

	drainLocal(): void {
		this.entries = this.entries.filter((e) => e.source !== "local");
	}

	clear(): void {
		this.entries.length = 0;
	}

	/**
	 * @param options.flush Flush on the busy→idle edge. Default true. Pass
	 * false when the caller settles the queue itself, as after an abort.
	 */
	setParentBusy(busy: boolean, options?: { flush?: boolean }): void {
		this.parentBusy = busy;
		if (!busy && options?.flush !== false) {
			this.flush();
		}
	}

	/**
	 * Hand every queued notification to the agent without starting a turn.
	 * Unlike flush(), this ignores busy state — the caller has already
	 * established that no run should follow.
	 */
	deferAll(): void {
		if (this._isWaiting) return;
		if (this.entries.length === 0) return;
		const combined = this.drainAll();
		this.config.deliverDeferred(combined);
	}

	setWaiting(waiting: boolean): void {
		this._isWaiting = waiting;
	}

	trackToolStart(toolCallId: string): void {
		this.pendingToolCalls.add(toolCallId);
	}

	trackToolEnd(toolCallId: string): void {
		this.pendingToolCalls.delete(toolCallId);
		if (this.pendingToolCalls.size === 0) {
			this.flush();
		}
	}

	clearPendingTools(): void {
		this.pendingToolCalls.clear();
	}

	get isWaiting(): boolean {
		return this._isWaiting;
	}

	get length(): number {
		return this.entries.length;
	}

	// ─── Private ─────────────────────────────────────────────────────────

	private doFlush(): void {
		if (this.entries.length === 0) return;

		this.parentBusy = true;
		const combined = this.entries.map((e) => e.xml).join("\n");
		this.entries.length = 0;
		this.config.deliver(combined);
	}
}
