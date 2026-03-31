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

	setParentBusy(busy: boolean): void {
		this.parentBusy = busy;
		if (!busy) {
			this.flush();
		}
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
