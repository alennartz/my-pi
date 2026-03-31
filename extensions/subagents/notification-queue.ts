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

interface QueueEntry {
	xml: string;
	source: NotificationSource;
}

export class NotificationQueue {
	private entries: QueueEntry[] = [];
	private parentBusy = false;
	private pendingToolCalls = new Set<string>();
	private _isWaiting = false;
	private waitResolve: ((result: string) => void) | null = null;
	private waitReject: ((err: Error) => void) | null = null;
	private abortCleanup: (() => void) | null = null;

	constructor(private config: NotificationQueueConfig) {}

	queue(xml: string, source: NotificationSource): void {
		this.entries.push({ xml, source });

		if (this._isWaiting) {
			this.resolveWait();
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

	drainLocal(): void {
		this.entries = this.entries.filter((e) => e.source !== "local");
	}

	clear(): void {
		if (this._isWaiting && this.waitReject) {
			const reject = this.waitReject;
			this.cleanupWait();
			reject(new Error("Queue cleared"));
		}
		this.entries.length = 0;
	}

	setParentBusy(busy: boolean): void {
		this.parentBusy = busy;
		if (!busy) {
			this.flush();
		}
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

	wait(opts?: WaitOptions): Promise<string> {
		if (this._isWaiting) {
			throw new Error("A wait is already active");
		}

		// Check for already-aborted signal before entering wait state
		if (opts?.signal?.aborted) {
			return Promise.reject(new Error("Aborted"));
		}

		// Check early satisfaction
		if (opts?.isAlreadySatisfied?.()) {
			const result = this.drain();
			return Promise.resolve(result);
		}

		this._isWaiting = true;

		return new Promise<string>((resolve, reject) => {
			this.waitResolve = resolve;
			this.waitReject = reject;

			if (opts?.signal) {
				const onAbort = () => {
					this.cleanupWait();
					reject(new Error("Aborted"));
				};
				opts.signal.addEventListener("abort", onAbort, { once: true });
				this.abortCleanup = () => opts.signal!.removeEventListener("abort", onAbort);
			}
		});
	}

	get isWaiting(): boolean {
		return this._isWaiting;
	}

	get length(): number {
		return this.entries.length;
	}

	// ─── Private ─────────────────────────────────────────────────────────

	private drain(): string {
		const combined = this.entries.map((e) => e.xml).join("\n");
		this.entries.length = 0;
		return combined;
	}

	private doFlush(): void {
		if (this.entries.length === 0) return;

		this.parentBusy = true;
		const combined = this.entries.map((e) => e.xml).join("\n");
		this.entries.length = 0;
		this.config.deliver(combined);
	}

	private resolveWait(): void {
		const resolve = this.waitResolve;
		this.cleanupWait();
		const result = this.drain();
		resolve?.(result);
	}

	private cleanupWait(): void {
		this._isWaiting = false;
		this.abortCleanup?.();
		this.abortCleanup = null;
		this.waitResolve = null;
		this.waitReject = null;
	}
}
