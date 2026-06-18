import { describe, it, expect, afterEach } from "vitest";
import * as net from "node:net";
import { StringDecoder } from "node:string_decoder";
import { Broker } from "./broker.js";
import { buildTopology } from "./channels.js";
import type { BrokerRequest, BrokerResponse } from "./messages.js";

/**
 * Minimal socket client for tests. Connects to the broker, registers, and
 * exposes:
 *   - send(req): write a JSONL request
 *   - next(): resolve with the next BrokerResponse received
 *   - all responses are also captured in `received` for assertion
 */
class TestClient {
	socket: net.Socket;
	/** Queue of received-but-not-yet-consumed responses. */
	private queue: BrokerResponse[] = [];
	private waiters: Array<(msg: BrokerResponse) => void> = [];
	private buffer = "";
	private decoder = new StringDecoder("utf8");

	constructor(socketPath: string) {
		this.socket = net.createConnection(socketPath);
		this.socket.on("data", (chunk: Buffer) => {
			this.buffer += this.decoder.write(chunk);
			while (true) {
				const idx = this.buffer.indexOf("\n");
				if (idx === -1) break;
				let line = this.buffer.slice(0, idx);
				this.buffer = this.buffer.slice(idx + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (!line) continue;
				let parsed: BrokerResponse;
				try {
					parsed = JSON.parse(line);
				} catch {
					continue;
				}
				const waiter = this.waiters.shift();
				if (waiter) waiter(parsed);
				else this.queue.push(parsed);
			}
		});
	}

	async register(agentId: string): Promise<void> {
		await new Promise<void>((resolve) => {
			if (this.socket.readyState === "open") return resolve();
			this.socket.once("connect", () => resolve());
		});
		this.write({ type: "register", agentId });
		const msg = await this.next();
		if (msg.type !== "registered") {
			throw new Error(`Expected registered, got ${msg.type}`);
		}
	}

	write(req: BrokerRequest): void {
		this.socket.write(JSON.stringify(req) + "\n");
	}

	next(): Promise<BrokerResponse> {
		if (this.queue.length > 0) {
			return Promise.resolve(this.queue.shift()!);
		}
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	/** Wait for the next response matching a predicate. */
	async nextMatching(pred: (m: BrokerResponse) => boolean): Promise<BrokerResponse> {
		while (true) {
			const msg = await this.next();
			if (pred(msg)) return msg;
		}
	}

	close(): void {
		this.socket.destroy();
	}
}

async function makeBroker(agentIds: string[]) {
	const topology = buildTopology(agentIds.map((id) => ({ id, channels: agentIds.filter((x) => x !== id) })));
	const parentMessages: BrokerResponse[] = [];
	const broker = new Broker({
		topology,
		onParentMessage: (msg) => parentMessages.push(msg),
	});
	await broker.start();
	return { broker, parentMessages };
}

describe("Broker.agentIdled", () => {
	let toCleanup: Array<{ close: () => Promise<void> | void }> = [];

	afterEach(async () => {
		for (const c of toCleanup) await c.close();
		toCleanup = [];
	});

	it("unblocks a parent send when the target child idles without responding", async () => {
		const { broker } = await makeBroker(["child"]);
		toCleanup.push({ close: () => broker.stop() });

		const parent = new TestClient(broker.socketPath);
		const child = new TestClient(broker.socketPath);
		toCleanup.push({ close: () => parent.close() }, { close: () => child.close() });

		await parent.register("parent");
		await child.register("child");

		// Parent issues a blocking send to child.
		parent.write({
			type: "send",
			from: "parent",
			to: "child",
			message: "hello",
			correlationId: "corr-1",
			expectResponse: true,
		});

		// Parent gets send_ack; child receives the message.
		const ack = await parent.next();
		expect(ack.type).toBe("send_ack");

		const delivered = await child.nextMatching((m) => m.type === "message");
		expect(delivered).toMatchObject({
			type: "message",
			from: "parent",
			correlationId: "corr-1",
			responseExpected: true,
		});

		// Child's turn ends without calling respond — simulate by invoking
		// the lifecycle hook the agent-set normally calls on agent_end.
		broker.agentIdled("child");

		// Parent's blocking send is now unblocked with a clear error.
		const errMsg = await parent.nextMatching((m) => m.type === "error");
		expect(errMsg).toMatchObject({
			type: "error",
			correlationId: "corr-1",
		});
		expect((errMsg as { error: string }).error).toMatch(/went idle without responding/);

		// Broker's correlation state is cleared, so it's quiet again.
		expect(broker.isQuiet()).toBe(true);
	});

	it("unblocks a sibling's blocking send when the target sibling idles without responding", async () => {
		const { broker } = await makeBroker(["alice", "bob"]);
		toCleanup.push({ close: () => broker.stop() });

		const alice = new TestClient(broker.socketPath);
		const bob = new TestClient(broker.socketPath);
		toCleanup.push({ close: () => alice.close() }, { close: () => bob.close() });

		await alice.register("alice");
		await bob.register("bob");

		// Alice issues a blocking send to her sibling Bob.
		alice.write({
			type: "send",
			from: "alice",
			to: "bob",
			message: "ping",
			correlationId: "corr-sib",
			expectResponse: true,
		});

		// Alice gets send_ack; Bob receives the message.
		const ack = await alice.next();
		expect(ack.type).toBe("send_ack");

		const delivered = await bob.nextMatching((m) => m.type === "message");
		expect(delivered).toMatchObject({
			type: "message",
			from: "alice",
			correlationId: "corr-sib",
			responseExpected: true,
		});

		// Bob's turn ends without responding.
		broker.agentIdled("bob");

		// Alice's blocking send unblocks with the same error.
		const errMsg = await alice.nextMatching((m) => m.type === "error");
		expect(errMsg).toMatchObject({
			type: "error",
			correlationId: "corr-sib",
		});
		expect((errMsg as { error: string }).error).toMatch(/went idle without responding/);
		expect((errMsg as { error: string }).error).toContain('"bob"');

		// Bob is still alive — a fresh send from Alice should still route.
		alice.write({
			type: "send",
			from: "alice",
			to: "bob",
			message: "still there?",
			correlationId: "corr-followup",
			expectResponse: false,
		});
		const ack2 = await alice.next();
		expect(ack2.type).toBe("send_ack");
		const delivered2 = await bob.nextMatching((m) => m.type === "message");
		expect(delivered2).toMatchObject({ type: "message", from: "alice", correlationId: "corr-followup" });

		expect(broker.isQuiet()).toBe(true);
	});
});

describe("Broker register after removal", () => {
	let toCleanup: Array<{ close: () => Promise<void> | void }> = [];

	afterEach(async () => {
		for (const c of toCleanup) await c.close();
		toCleanup = [];
	});

	it("clears the removed-agent tombstone when the id is re-registered", async () => {
		const { broker } = await makeBroker(["worker"]);
		toCleanup.push({ close: () => broker.stop() });

		const parent = new TestClient(broker.socketPath);
		toCleanup.push({ close: () => parent.close() });
		await parent.register("parent");

		const firstWorker = new TestClient(broker.socketPath);
		toCleanup.push({ close: () => firstWorker.close() });
		await firstWorker.register("worker");

		// Tear the worker down — sends to it now fail.
		broker.agentRemoved("worker");
		parent.write({ type: "send", from: "parent", to: "worker", message: "hi" });
		const removedErr = await parent.next();
		expect(removedErr.type).toBe("error");
		expect((removedErr as { error: string }).error).toMatch(/was removed/);

		// A new agent reuses the id — sends must route to it again.
		const secondWorker = new TestClient(broker.socketPath);
		toCleanup.push({ close: () => secondWorker.close() });
		await secondWorker.register("worker");

		parent.write({ type: "send", from: "parent", to: "worker", message: "hello again" });
		const ack = await parent.next();
		expect(ack.type).toBe("send_ack");
		const delivered = await secondWorker.nextMatching((m) => m.type === "message");
		expect(delivered).toMatchObject({ type: "message", from: "parent", message: "hello again" });
	});
});

describe("Broker ack-phase errors", () => {
	let toCleanup: Array<{ close: () => Promise<void> | void }> = [];

	afterEach(async () => {
		for (const c of toCleanup) await c.close();
		toCleanup = [];
	});

	it("omits correlationId on pre-flight errors so they resolve the ack waiter, not the response waiter", async () => {
		const { broker } = await makeBroker(["ghost"]);
		toCleanup.push({ close: () => broker.stop() });

		const parent = new TestClient(broker.socketPath);
		toCleanup.push({ close: () => parent.close() });
		await parent.register("parent");

		// "ghost" is in the topology but never connected.
		parent.write({
			type: "send",
			from: "parent",
			to: "ghost",
			message: "anyone there?",
			correlationId: "corr-ghost",
			expectResponse: true,
		});

		const err = await parent.next();
		expect(err.type).toBe("error");
		expect((err as { correlationId?: string }).correlationId).toBeUndefined();
		expect((err as { error: string }).error).toMatch(/not connected/);
	});
});

describe("Broker cancel", () => {
	let toCleanup: Array<{ close: () => Promise<void> | void }> = [];

	afterEach(async () => {
		for (const c of toCleanup) await c.close();
		toCleanup = [];
	});

	it("drops the pending correlation when the sender cancels an aborted blocking send", async () => {
		const { broker } = await makeBroker(["child"]);
		toCleanup.push({ close: () => broker.stop() });

		const parent = new TestClient(broker.socketPath);
		const child = new TestClient(broker.socketPath);
		toCleanup.push({ close: () => parent.close() }, { close: () => child.close() });
		await parent.register("parent");
		await child.register("child");

		parent.write({
			type: "send",
			from: "parent",
			to: "child",
			message: "question",
			correlationId: "corr-cancel",
			expectResponse: true,
		});
		const ack = await parent.next();
		expect(ack.type).toBe("send_ack");
		await child.nextMatching((m) => m.type === "message");

		// Sender aborts the blocking send.
		parent.write({ type: "cancel", correlationId: "corr-cancel" });

		// Barrier: requests on the same socket are processed in order, so once
		// this follow-up send is acked the cancel has been handled too.
		parent.write({ type: "send", from: "parent", to: "child", message: "barrier" });
		const barrierAck = await parent.next();
		expect(barrierAck.type).toBe("send_ack");

		// A late respond hits no pending correlation — responder is told, and
		// nothing is delivered to the sender's socket.
		child.write({ type: "respond", from: "child", correlationId: "corr-cancel", message: "too late" });
		// nextMatching: the barrier message is also in the child's queue.
		const lateErr = await child.nextMatching((m) => m.type === "error");
		expect((lateErr as { error: string }).error).toMatch(/No pending request/);

		expect(broker.isQuiet()).toBe(true);
	});
});

describe("Broker detach", () => {
	let toCleanup: Array<{ close: () => Promise<void> | void }> = [];

	afterEach(async () => {
		for (const c of toCleanup) await c.close();
		toCleanup = [];
	});

	it("drops the deadlock edge but keeps the pending correlation so a late respond still delivers", async () => {
		const { broker } = await makeBroker(["child"]);
		toCleanup.push({ close: () => broker.stop() });

		const parent = new TestClient(broker.socketPath);
		const child = new TestClient(broker.socketPath);
		toCleanup.push({ close: () => parent.close() }, { close: () => child.close() });
		await parent.register("parent");
		await child.register("child");

		parent.write({
			type: "send",
			from: "parent",
			to: "child",
			message: "question",
			correlationId: "corr-detach",
			expectResponse: true,
		});
		expect((await parent.next()).type).toBe("send_ack");
		await child.nextMatching((m) => m.type === "message");

		// While the edge parent→child exists, a reverse blocking send child→parent
		// would close a cycle and is rejected.
		child.write({
			type: "send",
			from: "child",
			to: "parent",
			message: "reverse",
			correlationId: "c-pre",
			expectResponse: true,
		});
		const preErr = await child.nextMatching((m) => m.type === "error");
		expect((preErr as { error: string }).error).toMatch(/Deadlock/);

		// Interrupt-without-cancel: detach the original send.
		parent.write({ type: "detach", correlationId: "corr-detach" });

		// Barrier: ensures the detach has been processed before we continue.
		parent.write({ type: "send", from: "parent", to: "child", message: "barrier" });
		expect((await parent.next()).type).toBe("send_ack");

		// The edge is gone, so the same reverse blocking send is now allowed.
		child.write({
			type: "send",
			from: "child",
			to: "parent",
			message: "reverse ok",
			correlationId: "c-ok",
			expectResponse: true,
		});
		const okFrame = await child.nextMatching((m) => m.type === "send_ack" || m.type === "error");
		expect(okFrame.type).toBe("send_ack");

		// And the original correlation is still pending: a late respond is
		// delivered to the parent's socket instead of erroring.
		child.write({ type: "respond", from: "child", correlationId: "corr-detach", message: "late but delivered" });
		const delivered = await parent.nextMatching((m) => m.type === "response");
		expect((delivered as { correlationId: string }).correlationId).toBe("corr-detach");
		expect((delivered as { message: string }).message).toBe("late but delivered");
	});
});
