import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type {
  AgentNodeSnapshot,
  AgentSessionRegistry,
  AgentRegistryNode,
  RegistryEvent,
  RegisteredAgentNode,
} from "./agent-session-registry.js";
import type { AgentPath } from "./agent-path.js";
import type { ManagedChildSession } from "./managed-child-session.js";
import { createSubagentLifecycleReader } from "./lifecycle.js";
import {
  createSubagentProvider,
  type ReplayResult,
  type SubagentEvent,
  type SubagentLeaseEvent,
  type SubagentOwnerControlPort,
  type SubagentSemanticFact,
  type SubagentProviderOptions,
} from "./provider.js";

const workerPath: AgentPath = ["worker"];
const scoutPath: AgentPath = ["worker", "scout"];
const workerIncarnation = "incarnation-worker";
const scoutIncarnation = "incarnation-scout";

function samePath(left: AgentPath, right: AgentPath): boolean {
  return (
    left.length === right.length &&
    left.every((part, index) => part === right[index])
  );
}

function node(
  path: AgentPath,
  sessionId: string,
  parentPath: AgentPath | null,
  task: string,
  sessionFile = `/tmp/${sessionId}.jsonl`,
): RegisteredAgentNode {
  const snapshot: AgentNodeSnapshot = {
    path,
    parentPath,
    localId: path.at(-1) ?? null,
    ownership: "registry",
    sessionId,
    sessionFile,
    cwd: "/tmp",
    task,
    channels: ["parent"],
    operational: {
      state: "idle",
      usage: {
        input: 10,
        output: 4,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.01,
        turns: 1,
      },
      lastTurnInput: 200,
      contextWindow: 800,
      hasSubgroup: path.length === 1,
      pendingCorrelations: [],
      waitingFor: [],
    },
  };
  const native = {
    sessionId,
    sessionFile: snapshot.sessionFile,
    dispose: vi.fn(async () => undefined),
  } as unknown as AgentSession;
  const managed = { session: native } as unknown as ManagedChildSession;
  return { snapshot, session: managed } as RegisteredAgentNode;
}

function registryFixture(workerSessionFile?: string): {
  registry: AgentSessionRegistry;
  ownerControl: SubagentOwnerControlPort;
  emit(event: RegistryEvent): void;
  worker: RegisteredAgentNode;
  scout: RegisteredAgentNode;
  replace(path: AgentPath, sessionId: string): RegisteredAgentNode;
  add(next: RegisteredAgentNode): void;
  unavailable(path: AgentPath): void;
} {
  const worker = node(
    workerPath,
    "session-worker",
    [],
    "Review callback ownership.",
    workerSessionFile,
  );
  const scout = node(
    scoutPath,
    "session-scout",
    workerPath,
    "Confirm session mutation.",
  );
  const nodes: AgentRegistryNode[] = [worker, scout];
  const listeners = new Set<(event: RegistryEvent) => void>();
  const emit = (event: RegistryEvent) => {
    for (const listener of listeners) listener(event);
  };
  const registry = {
    get: vi.fn((path: AgentPath) =>
      nodes.find((item) => samePath(item.snapshot.path, path)),
    ),
    listDescendants: vi.fn((parent: AgentPath) =>
      nodes
        .filter(
          (item) =>
            item.snapshot.path.length > parent.length &&
            parent.every((part, index) => item.snapshot.path[index] === part),
        )
        .map((item) => item.snapshot),
    ),
    subscribe: vi.fn((next: (event: RegistryEvent) => void) => {
      listeners.add(next);
      return () => listeners.delete(next);
    }),
    remove: vi.fn(async (path: AgentPath) => {
      for (const item of [...nodes]) {
        if (path.every((part, index) => item.snapshot.path[index] === part)) {
          nodes.splice(nodes.indexOf(item), 1);
          emit({ type: "node_removed", node: item.snapshot });
        }
      }
    }),
  } as unknown as AgentSessionRegistry;
  const ownerControl: SubagentOwnerControlPort = {
    teardown: vi.fn(async (path, incarnation) => {
      const current = nodes.find((item) => samePath(item.snapshot.path, path));
      if (!current) return { path, removed: false, incarnation, reason: "not_found" as const };
      await registry.remove(path);
      return { path, removed: true, incarnation, sessionId: current.snapshot.sessionId, reason: "removed" as const };
    }),
    stop: vi.fn(async () => undefined),
    resurrect: vi.fn(async (request) => ({
      path: [...request.parentPath, request.localId],
      sessionId: request.sessionId,
      incarnation: "resurrected-incarnation",
    })),
  };
  return {
    registry,
    ownerControl,
    emit,
    worker,
    scout,
    replace(path, sessionId) {
      const index = nodes.findIndex((item) => samePath(item.snapshot.path, path));
      const previous = nodes[index].snapshot;
      const next = node(path, sessionId, previous.parentPath, previous.task ?? "");
      nodes[index] = next;
      emit({ type: "node_updated", previous, node: next.snapshot });
      return next;
    },
    add(next) {
      nodes.push(next);
      emit({ type: "node_added", node: next.snapshot });
    },
    unavailable(path) {
      const index = nodes.findIndex((item) => samePath(item.snapshot.path, path));
      const previous = nodes[index].snapshot;
      const snapshot = { ...previous, sessionId: `${previous.sessionId}-unavailable` };
      const managed = { get session() { throw new Error("runtime unavailable"); } } as unknown as ManagedChildSession;
      nodes[index] = { snapshot, session: managed } as RegisteredAgentNode;
      emit({ type: "node_updated", previous, node: snapshot });
    },
  };
}

function setup(overrides: Partial<SubagentProviderOptions> = {}) {
  const fixture = registryFixture();
  const provider = createSubagentProvider({
    registry: fixture.registry,
    ownerControl: fixture.ownerControl,
    ...overrides,
  });
  return { provider, fixture };
}

describe("SubagentProvider snapshot and replay", () => {
  it("publishes a root-relative snapshot with its provider cursor at the boundary", () => {
    const { provider } = setup();
    const snapshot = provider.snapshot();

    expect(snapshot.cursor).toEqual({
      epoch: expect.any(String),
      sequence: expect.any(Number),
    });
    expect(snapshot.nodes.map((node) => node.path)).toEqual(
      expect.arrayContaining([workerPath, scoutPath]),
    );
    expect(snapshot.nodes.find((node) => samePath(node.path, workerPath))?.contextFill).toBe(25);
  });

  it("exposes context fill as an integer percentage within 0–100", () => {
    const { provider, fixture } = setup();
    const overfilled = node(["overfilled"], "overfilled-session", [], "Test context fill");
    fixture.add({
      ...overfilled,
      snapshot: { ...overfilled.snapshot, operational: { ...overfilled.snapshot.operational, lastTurnInput: 1600 } },
    });
    const value = provider.snapshot().nodes.find((item) => samePath(item.path, ["overfilled"]))?.contextFill;
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(100);
  });

  it("replays ordered semantic events after an observed cursor", () => {
    const { provider, fixture } = setup();
    const boundary = provider.snapshot().cursor;
    const observed: SubagentEvent[] = [];
    const unsubscribe = provider.subscribe((event) => observed.push(event));
    const first = { ...fixture.worker.snapshot, sessionId: "worker-v2" };
    const second = { ...first, sessionId: "worker-v3" };
    fixture.emit({ type: "node_updated", previous: fixture.worker.snapshot, node: first });
    fixture.emit({ type: "node_updated", previous: first, node: second });
    const replay: ReplayResult = provider.replay(boundary);

    expect(observed).toHaveLength(2);
    expect(replay.kind).toBe("events");
    if (replay.kind === "events") {
      expect(replay.events).toEqual(observed);
      expect(replay.events[0].cursor.sequence).toBeGreaterThan(boundary.sequence);
      expect(replay.events[1].cursor.sequence).toBeGreaterThan(replay.events[0].cursor.sequence);
    }
    unsubscribe();
  });

  it("delivers and replays delegation and communication facts without a view", async () => {
    const listeners = new Set<(fact: SubagentSemanticFact) => void>();
    const { provider } = setup({
      semanticEvents: { subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } },
    });
    const boundary = provider.snapshot().cursor;
    const observed: SubagentEvent[] = [];
    let delivered!: () => void;
    const allDelivered = new Promise<void>((resolve) => { delivered = resolve; });
    const unsubscribe = provider.subscribe((event) => {
      observed.push(event);
      if (event.eventId === "async-completion") delivered();
    });
    const common = { from: workerPath, to: scoutPath, correlationId: "corr-1", responseExpected: true };
    const facts: SubagentSemanticFact[] = [
      { eventId: "delegate", path: workerPath, kind: "delegation", relatedPiEvents: [], data: { invocationId: "call-1", awaitsResult: true, children: [{ path: scoutPath, task: "Confirm session mutation." }] } },
      { eventId: "sent", path: scoutPath, kind: "message_thread", relatedPiEvents: [], data: { ...common, phase: "sent", text: "Confirm the callback owner." } },
      { eventId: "received", path: scoutPath, kind: "message_thread", relatedPiEvents: [], data: { ...common, phase: "received", text: "Confirm the callback owner." } },
      { eventId: "response", path: scoutPath, kind: "message_thread", relatedPiEvents: [], data: { ...common, from: scoutPath, to: workerPath, phase: "response", text: "The session store." } },
      { eventId: "failure", path: scoutPath, kind: "message_thread", relatedPiEvents: [], data: { ...common, phase: "failure", text: "Confirm the callback owner.", error: "child unavailable" } },
      { eventId: "awaited-completion", path: scoutPath, kind: "completion", relatedPiEvents: [], data: { delivery: "awaited", invocationId: "call-1", status: "idle", output: "The session store." } },
      { eventId: "async-completion", path: scoutPath, kind: "completion", relatedPiEvents: [], data: { delivery: "asynchronous", status: "errored", error: "child unavailable" } },
    ];
    for (const fact of facts) for (const listener of listeners) listener(fact);
    await allDelivered;

    expect(observed.map(({ eventId, kind, data }) => ({ eventId, kind, data }))).toEqual(
      facts.map(({ eventId, kind, data }) => ({ eventId, kind, data })),
    );
    const replay = provider.replay(boundary);
    expect(replay.kind).toBe("events");
    if (replay.kind === "events") expect(replay.events).toEqual(observed);
    unsubscribe();
  });

  it("replays add, removal, and resurrection from existing lifecycle records", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-provider-test-"));
    try {
      const paths = {
        rootDir: path.join(root, "parent.subagents"),
        childSessionsDir: path.join(root, "parent.subagents", "sessions"),
        logFile: path.join(root, "parent.subagents", "agents.jsonl"),
      };
      fs.mkdirSync(paths.childSessionsDir, { recursive: true });
      const sessionFile = path.join(paths.childSessionsDir, "worker.jsonl");
      const sessionId = "session-worker";
      const added = {
        type: "agent_added", version: 1, timestamp: "2026-01-01T00:00:01.000Z",
        id: "worker", kind: "agent", task: "Review callback ownership.",
        channels: ["parent"], sessionId, sessionFile,
      };
      const records = [
        { type: "init", version: 1, timestamp: "2026-01-01T00:00:00.000Z", parentSessionFile: path.join(root, "parent.jsonl"), childSessionsDir: paths.childSessionsDir },
        added,
        { type: "agent_removed", version: 1, timestamp: "2026-01-01T00:00:02.000Z", id: "worker", sessionId, sessionFile },
        { ...added, timestamp: "2026-01-01T00:00:03.000Z" },
      ];
      fs.writeFileSync(paths.logFile, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
      fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: root }) + "\n");
      const fixture = registryFixture(sessionFile);
      const provider = createSubagentProvider({
        registry: fixture.registry,
        ownerControl: fixture.ownerControl,
        lifecycle: createSubagentLifecycleReader(paths),
      });

      const replay = provider.replay();
      expect(replay.kind).toBe("events");
      if (replay.kind === "events") {
        const firstAdd = replay.events.findIndex((event) => event.kind === "node_added" && samePath(event.path, workerPath));
        const removed = replay.events.findIndex((event) => event.kind === "node_removed" && samePath(event.path, workerPath));
        const restored = replay.events.findIndex((event, index) => index > removed && (event.kind === "node_added" || event.kind === "resurrect") && samePath(event.path, workerPath));
        expect(firstAdd).toBeGreaterThanOrEqual(0);
        expect(removed).toBeGreaterThan(firstAdd);
        expect(restored).toBeGreaterThan(removed);
      }
      expect(provider.snapshot().nodes.find((node) => samePath(node.path, workerPath))?.sessionId).toBe(sessionId);
      const lease = await provider.acquire(workerPath);
      expect(lease.session.sessionFile).toBe(sessionFile);
      await lease.release();
      expect(await provider.teardown(workerPath, workerIncarnation)).toMatchObject({ path: workerPath, removed: true, sessionId });
      expect(fs.existsSync(sessionFile)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires a fresh snapshot when a provider restarts with a new epoch", () => {
    const fixture = registryFixture();
    const first = createSubagentProvider({ registry: fixture.registry, ownerControl: fixture.ownerControl });
    const boundary = first.snapshot().cursor;
    const restarted = createSubagentProvider({ registry: fixture.registry, ownerControl: fixture.ownerControl });
    expect(restarted.snapshot().cursor.epoch).not.toBe(boundary.epoch);
    const replay = restarted.replay(boundary);

    expect(replay).toEqual({
      kind: "snapshot_required",
      reason: "epoch_changed",
    });
  });

  it("requires a fresh snapshot when the requested history is no longer retained", () => {
    const { provider, fixture } = setup({ historyLimit: 2 });
    const boundary = provider.snapshot().cursor;
    for (const id of ["worker-v2", "worker-v3", "worker-v4"]) fixture.replace(workerPath, id);
    const replay = provider.replay(boundary);

    expect(replay).toEqual({
      kind: "snapshot_required",
      reason: "history_unavailable",
    });
  });
});

describe("SubagentProvider path identity and leases", () => {
  it("keeps the public path stable when the runtime session id changes", () => {
    const { provider, fixture } = setup();
    const initial = provider.snapshot();
    const before = initial.nodes.find((item) =>
      samePath(item.path, workerPath),
    );
    const events: SubagentEvent[] = [];
    const unsubscribe = provider.subscribe((item) => events.push(item));
    const replacement: AgentNodeSnapshot = {
      ...fixture.worker.snapshot,
      sessionId: "session-worker-replacement",
    };
    fixture.emit({
      type: "node_updated",
      previous: fixture.worker.snapshot,
      node: replacement,
    });

    const replay = provider.replay(initial.cursor);

    expect(before?.path).toEqual(workerPath);
    expect(replay.kind).toBe("events");
    if (replay.kind === "events") {
      const update = replay.events.find((item) => item.kind === "node_updated");
      expect(update?.path).toEqual(before?.path);
      expect(update?.data).toEqual(
        expect.objectContaining({ sessionId: "session-worker-replacement" }),
      );
    }
    expect(events.every((item) => item.path.length > 0)).toBe(true);
    unsubscribe();
  });

  it("borrows the native child session and releases it without disposal", async () => {
    const { provider, fixture } = setup();
    const native = fixture.scout.session.session;
    const lease = await provider.acquire(scoutPath);

    expect(lease.path).toEqual(scoutPath);
    expect(lease.session).toBe(native);
    await lease.release();
    await lease.release();
    expect(native.dispose).not.toHaveBeenCalled();
  });

  it("lets multiple clients borrow independently without disposing the child", async () => {
    const { provider, fixture } = setup();
    const first = await provider.acquire(scoutPath);
    const second = await provider.acquire(scoutPath);
    const native = fixture.scout.session.session;

    await first.release();
    expect(second.session).toBe(native);
    expect(native.dispose).not.toHaveBeenCalled();
    await second.release();
    expect(native.dispose).not.toHaveBeenCalled();
  });

  it("rebinds existing leases to a replacement native runtime", async () => {
    const { provider, fixture } = setup();
    const lease = await provider.acquire(scoutPath);
    let resolveRebound!: (event: SubagentLeaseEvent) => void;
    const rebound = new Promise<SubagentLeaseEvent>((resolve) => { resolveRebound = resolve; });
    const unsubscribe = lease.subscribe((event) => { if (event.kind === "rebound") resolveRebound(event); });
    const replacement = fixture.replace(scoutPath, "session-scout-v2");

    expect(await rebound).toEqual({ kind: "rebound", session: replacement.session.session });
    expect(lease.session).toBe(replacement.session.session);
    unsubscribe();
    await lease.release();
  });

  it("invalidates old leases on teardown even when the path is reused", async () => {
    const { provider, fixture } = setup();
    const lease = await provider.acquire(scoutPath);
    let resolveClosed!: (event: SubagentLeaseEvent) => void;
    const closed = new Promise<SubagentLeaseEvent>((resolve) => { resolveClosed = resolve; });
    lease.subscribe((event) => { if (event.kind === "closed") resolveClosed(event); });
    await provider.teardown(scoutPath, scoutIncarnation);
    const replacement = node(scoutPath, "session-scout-new", workerPath, "New task");
    fixture.add(replacement);
    const newLease = await provider.acquire(scoutPath);

    expect(await closed).toEqual({ kind: "closed", reason: "removed" });
    expect(() => lease.session).toThrow();
    expect(newLease.session).toBe(replacement.session.session);
    await lease.release();
    await newLease.release();
  });

  it("closes a lease if the replacement runtime is unavailable", async () => {
    const { provider, fixture } = setup();
    const lease = await provider.acquire(scoutPath);
    let resolveClosed!: (event: SubagentLeaseEvent) => void;
    const closed = new Promise<SubagentLeaseEvent>((resolve) => { resolveClosed = resolve; });
    lease.subscribe((event) => { if (event.kind === "closed") resolveClosed(event); });
    fixture.unavailable(scoutPath);

    expect(await closed).toEqual({ kind: "closed", reason: "unavailable" });
    expect(() => lease.session).toThrow();
    await lease.release();
  });

  it("rejects root and unknown paths and distinguishes path segments", async () => {
    const { provider, fixture } = setup();
    const flat = node(["worker/scout"], "flat-session", [], "Different child");
    fixture.add(flat);

    await expect(provider.acquire([])).rejects.toThrow();
    await expect(provider.acquire(["missing"])).rejects.toThrow();
    const nestedLease = await provider.acquire(scoutPath);
    const flatLease = await provider.acquire(["worker/scout"]);
    expect(nestedLease.session).toBe(fixture.scout.session.session);
    expect(flatLease.session).toBe(flat.session.session);
    await provider.teardown(["worker/scout"], "incarnation-flat");
    expect(nestedLease.session).toBe(fixture.scout.session.session);
    expect(() => flatLease.session).toThrow();
    await nestedLease.release();
    await flatLease.release();
  });

  it("reports teardown by public path without exposing runtime disposal", async () => {
    const { provider } = setup();
    const result = await provider.teardown(scoutPath, scoutIncarnation);

    expect(result.path).toEqual(scoutPath);
    expect(result.removed).toBe(true);
    expect(result).toHaveProperty("sessionId");
  });
});
