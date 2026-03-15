/**
 * Unix socket message broker for inter-agent communication.
 *
 * Hub-and-spoke topology: all children connect to the parent's broker.
 * The broker validates channels, detects deadlocks, and forwards messages.
 * Children never communicate directly — the broker is the sole routing authority.
 */

import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { type Topology, canSend } from "./channels.js";
import { DeadlockGraph } from "./deadlock.js";
import type { BrokerRequest, BrokerResponse } from "./messages.js";

export interface BrokerOptions {
	topology: Topology;
	onParentMessage: (msg: BrokerResponse) => void;
	onBlockingSendStart?: (from: string, to: string, correlationId: string) => void;
	onBlockingSendEnd?: (from: string, correlationId: string) => void;
}

interface PendingCorrelation {
	correlationId: string;
	from: string;
	fromSocket: net.Socket;
}

export class Broker {
	readonly socketPath: string;
	private server: net.Server | null = null;
	private connections = new Map<string, net.Socket>();
	private deadlockGraph = new DeadlockGraph();
	private pendingCorrelations = new Map<string, PendingCorrelation>();
	private failedAgents = new Set<string>();
	private topology: Topology;
	private onParentMessage: (msg: BrokerResponse) => void;

	private onBlockingSendStart?: (from: string, to: string, correlationId: string) => void;
	private onBlockingSendEnd?: (from: string, correlationId: string) => void;

	constructor(opts: BrokerOptions) {
		this.topology = opts.topology;
		this.onParentMessage = opts.onParentMessage;
		this.onBlockingSendStart = opts.onBlockingSendStart;
		this.onBlockingSendEnd = opts.onBlockingSendEnd;
		this.socketPath = path.join(os.tmpdir(), `pi-broker-${crypto.randomUUID()}.sock`);
	}

	start(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.server = net.createServer((socket) => this.handleConnection(socket));
			this.server.on("error", reject);
			this.server.listen(this.socketPath, () => resolve());
		});
	}

	async stop(): Promise<void> {
		// Close all client connections
		for (const [, socket] of this.connections) {
			socket.destroy();
		}
		this.connections.clear();

		// Close server
		if (this.server) {
			await new Promise<void>((resolve) => {
				this.server!.close(() => resolve());
			});
			this.server = null;
		}

		// Cleanup socket file
		try {
			const fs = await import("node:fs");
			fs.unlinkSync(this.socketPath);
		} catch {}
	}

	agentDied(agentId: string): void {
		this.failedAgents.add(agentId);

		// Send synthetic error responses to all blocked senders waiting on this agent
		for (const [corrId, pending] of this.pendingCorrelations) {
			if (this.getTargetFromCorrelation(corrId) === agentId) {
				this.deadlockGraph.removeEdge(pending.from, agentId);
				this.writeTo(pending.fromSocket, {
					type: "error",
					correlationId: corrId,
					error: `Agent "${agentId}" died while waiting for response`,
				});
				this.pendingCorrelations.delete(corrId);
				this.onBlockingSendEnd?.(pending.from, corrId);
			}
		}

		// Also clean up correlations where the dead agent was the sender
		for (const [corrId, pending] of this.pendingCorrelations) {
			if (pending.from === agentId) {
				const target = this.correlationTargets.get(corrId);
				if (target) {
					this.deadlockGraph.removeEdge(agentId, target);
					this.correlationTargets.delete(corrId);
				}
				this.pendingCorrelations.delete(corrId);
				this.onBlockingSendEnd?.(agentId, corrId);
			}
		}

		this.deadlockGraph.removeAllEdgesTo(agentId);

		// Close socket
		const socket = this.connections.get(agentId);
		if (socket) {
			socket.destroy();
			this.connections.delete(agentId);
		}
	}

	isQuiet(): boolean {
		return this.pendingCorrelations.size === 0;
	}

	getConnectedAgentIds(): string[] {
		return Array.from(this.connections.keys());
	}

	// ─── Internal ────────────────────────────────────────────────────────

	/** Map correlation IDs to the target agent they're waiting on. */
	private correlationTargets = new Map<string, string>();

	private getTargetFromCorrelation(corrId: string): string | undefined {
		return this.correlationTargets.get(corrId);
	}

	private handleConnection(socket: net.Socket): void {
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		let agentId: string | null = null;

		socket.on("data", (chunk: Buffer) => {
			buffer += decoder.write(chunk);
			while (true) {
				const idx = buffer.indexOf("\n");
				if (idx === -1) break;
				let line = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (!line) continue;

				let request: BrokerRequest;
				try {
					request = JSON.parse(line);
				} catch {
					continue;
				}

				if (request.type === "register") {
					agentId = request.agentId;
					this.connections.set(agentId, socket);
					this.writeTo(socket, { type: "registered" });
					continue;
				}

				if (!agentId) {
					this.writeTo(socket, { type: "error", error: "Must register before sending messages" });
					continue;
				}

				this.handleRequest(request, socket, agentId);
			}
		});

		socket.on("close", () => {
			if (agentId) {
				this.connections.delete(agentId);
			}
		});

		socket.on("error", () => {
			if (agentId) {
				this.connections.delete(agentId);
			}
		});
	}

	private handleRequest(request: BrokerRequest, socket: net.Socket, senderId: string): void {
		if (request.type === "send") {
			this.handleSend(request, socket, senderId);
		} else if (request.type === "respond") {
			this.handleRespond(request, socket, senderId);
		}
	}

	private handleSend(
		request: Extract<BrokerRequest, { type: "send" }>,
		senderSocket: net.Socket,
		senderId: string,
	): void {
		const { to, message, correlationId, expectResponse } = request;

		// Channel enforcement
		if (!canSend(this.topology, senderId, to)) {
			this.writeTo(senderSocket, {
				type: "error",
				correlationId,
				error: `Channel violation: "${senderId}" cannot send to "${to}"`,
			});
			return;
		}

		// Dead agent check
		if (this.failedAgents.has(to)) {
			this.writeTo(senderSocket, {
				type: "error",
				correlationId,
				error: `Agent "${to}" has failed and cannot receive messages`,
			});
			return;
		}

		// Deadlock check for blocking sends
		if (expectResponse && correlationId) {
			if (this.deadlockGraph.wouldCauseCycle(senderId, to)) {
				this.writeTo(senderSocket, {
					type: "error",
					correlationId,
					error: `Deadlock detected: blocking send from "${senderId}" to "${to}" would create a cycle`,
				});
				return;
			}
			this.deadlockGraph.addEdge(senderId, to);
			this.pendingCorrelations.set(correlationId, {
				correlationId,
				from: senderId,
				fromSocket: senderSocket,
			});
			this.correlationTargets.set(correlationId, to);
			this.onBlockingSendStart?.(senderId, to, correlationId);
		}

		// Route message
		if (to === "parent") {
			this.onParentMessage({
				type: "message",
				from: senderId,
				message,
				correlationId,
				responseExpected: expectResponse,
			});
			// Ack the send (for both fire-and-forget and blocking)
			this.writeTo(senderSocket, { type: "send_ack" });
		} else {
			const targetSocket = this.connections.get(to);
			if (!targetSocket) {
				// Target not connected (yet or died without being marked failed)
				if (expectResponse && correlationId) {
					this.deadlockGraph.removeEdge(senderId, to);
					this.pendingCorrelations.delete(correlationId);
					this.correlationTargets.delete(correlationId);
				}
				this.writeTo(senderSocket, {
					type: "error",
					correlationId,
					error: `Agent "${to}" is not connected`,
				});
				return;
			}

			this.writeTo(targetSocket, {
				type: "message",
				from: senderId,
				message,
				correlationId,
				responseExpected: expectResponse,
			});

			// Ack the send (for both fire-and-forget and blocking)
			this.writeTo(senderSocket, { type: "send_ack" });
		}
	}

	private handleRespond(
		request: Extract<BrokerRequest, { type: "respond" }>,
		responderSocket: net.Socket,
		_responderId: string,
	): void {
		const { correlationId, message } = request;

		const pending = this.pendingCorrelations.get(correlationId);
		if (!pending) {
			this.writeTo(responderSocket, {
				type: "error",
				error: `No pending request for correlation ID "${correlationId}"`,
			});
			return;
		}

		// Remove deadlock edge
		const target = this.correlationTargets.get(correlationId);
		if (target) {
			this.deadlockGraph.removeEdge(pending.from, target);
			this.correlationTargets.delete(correlationId);
		}

		// Deliver response to original sender
		this.writeTo(pending.fromSocket, {
			type: "response",
			correlationId,
			message,
		});

		this.pendingCorrelations.delete(correlationId);
		this.onBlockingSendEnd?.(pending.from, correlationId);

		// Ack the responder
		this.writeTo(responderSocket, { type: "send_ack" });
	}

	private writeTo(socket: net.Socket, msg: BrokerResponse): void {
		try {
			socket.write(JSON.stringify(msg) + "\n");
		} catch {
			// Socket may have closed
		}
	}
}
