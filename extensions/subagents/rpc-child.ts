/**
 * Minimal RPC protocol wrapper around `pi --mode rpc`.
 *
 * Implements JSONL framing over stdin/stdout: writes JSON commands to stdin,
 * reads JSON events and responses from stdout using LF-delimited line splitting.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface RpcChildOptions {
	cwd?: string;
	env?: Record<string, string>;
	args?: string[];
}

export class RpcChild {
	private proc: ChildProcess | null = null;
	private listeners: Set<(event: any) => void> = new Set();
	private pendingRequests = new Map<string, { resolve: (value: any) => void; reject: (err: Error) => void }>();
	private nextId = 1;
	private _exitCode: number | null = null;
	private _stderr = "";
	private opts: RpcChildOptions;

	constructor(opts: RpcChildOptions = {}) {
		this.opts = opts;
	}

	get exitCode(): number | null {
		return this._exitCode;
	}

	get pid(): number | undefined {
		return this.proc?.pid;
	}

	get stderr(): string {
		return this._stderr;
	}

	start(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const args = ["--mode", "rpc", ...(this.opts.args ?? [])];
			const env = this.opts.env ? { ...process.env, ...this.opts.env } : undefined;

			this.proc = spawn("pi", args, {
				cwd: this.opts.cwd,
				env,
				stdio: ["pipe", "pipe", "pipe"],
				shell: false,
			});

			const decoder = new StringDecoder("utf8");
			let buffer = "";
			let started = false;

			this.proc.stdout!.on("data", (chunk: Buffer) => {
				buffer += decoder.write(chunk);
				while (true) {
					const idx = buffer.indexOf("\n");
					if (idx === -1) break;
					let line = buffer.slice(0, idx);
					buffer = buffer.slice(idx + 1);
					if (line.endsWith("\r")) line = line.slice(0, -1);
					if (!line) continue;

					let parsed: any;
					try {
						parsed = JSON.parse(line);
					} catch {
						continue;
					}

					// Match responses to pending requests
					if (parsed.type === "response" && parsed.id && this.pendingRequests.has(parsed.id)) {
						const pending = this.pendingRequests.get(parsed.id)!;
						this.pendingRequests.delete(parsed.id);
						if (parsed.success) {
							pending.resolve(parsed);
						} else {
							pending.reject(new Error(parsed.error || "RPC command failed"));
						}
						continue;
					}

					// Dispatch to event listeners
					for (const listener of this.listeners) {
						try {
							listener(parsed);
						} catch {
							// Ignore listener errors
						}
					}
				}
			});

			this.proc.stderr!.on("data", (data: Buffer) => {
				this._stderr += data.toString();
			});

			this.proc.on("error", (err) => {
				if (!started) reject(err);
			});

			this.proc.on("close", (code) => {
				this._exitCode = code ?? 1;
				// Flush remaining buffer
				const remaining = buffer + decoder.end();
				if (remaining.trim()) {
					try {
						const parsed = JSON.parse(remaining);
						for (const listener of this.listeners) {
							try {
								listener(parsed);
							} catch {}
						}
					} catch {}
				}
				// Reject any pending requests
				for (const [, pending] of this.pendingRequests) {
					pending.reject(new Error(`RPC child exited with code ${this._exitCode}`));
				}
				this.pendingRequests.clear();
				if (!started) reject(new Error(`pi exited with code ${this._exitCode} before ready`));
			});

			// RPC mode is ready as soon as the process spawns successfully.
			// Verify readiness by sending a get_state command.
			this.proc.on("spawn", () => {
				started = true;
				this.sendCommand({ type: "get_state" })
					.then(() => resolve())
					.catch(reject);
			});
		});
	}

	private sendCommand(cmd: Record<string, any>): Promise<any> {
		if (!this.proc?.stdin?.writable) {
			return Promise.reject(new Error("RPC child not running"));
		}
		const id = `req-${this.nextId++}`;
		const full = { ...cmd, id };
		return new Promise((resolve, reject) => {
			this.pendingRequests.set(id, { resolve, reject });
			this.proc!.stdin!.write(JSON.stringify(full) + "\n");
		});
	}

	async prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<void> {
		const cmd: any = { type: "prompt", message };
		if (streamingBehavior) cmd.streamingBehavior = streamingBehavior;
		await this.sendCommand(cmd);
	}

	async abort(): Promise<void> {
		await this.sendCommand({ type: "abort" });
	}

	onEvent(listener: (event: any) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	async stop(): Promise<void> {
		if (!this.proc || this._exitCode !== null) return;

		return new Promise<void>((resolve) => {
			const proc = this.proc!;
			const killTimer = setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {}
			}, 5000);

			proc.on("close", () => {
				clearTimeout(killTimer);
				resolve();
			});

			try {
				proc.kill("SIGTERM");
			} catch {
				clearTimeout(killTimer);
				resolve();
			}
		});
	}
}
