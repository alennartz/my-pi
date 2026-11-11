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
import {
  createSubagentProvider,
  type FeedCursor,
  type ReplayResult,
  type SubagentEvent,
  type SubagentProviderOptions,
} from "./provider.js";

const workerPath: AgentPath = ["worker"];
const scoutPath: AgentPath = ["worker", "scout"];

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
): RegisteredAgentNode {
  const snapshot: AgentNodeSnapshot = {
    path,
    parentPath,
    localId: path.at(-1) ?? null,
    ownership: "registry",
    sessionId,
    sessionFile: `/tmp/${sessionId}.jsonl`,
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
      lastTurnInput: 0,
      hasSubgroup: path.length === 1,
      pendingCorrelations: [],
      waitingFor: [],
    },
  };
  const native = {
    sessionId,
    sessionFile: snapshot.sessionFile,
  } as unknown as AgentSession;
  const managed = { session: native } as unknown as ManagedChildSession;
  return { snapshot, session: managed } as RegisteredAgentNode;
}

function registryFixture(): {
  registry: AgentSessionRegistry;
  emit(event: RegistryEvent): void;
  worker: RegisteredAgentNode;
  scout: RegisteredAgentNode;
} {
  const worker = node(
    workerPath,
    "session-worker",
    [],
    "Review callback ownership.",
  );
  const scout = node(
    scoutPath,
    "session-scout",
    workerPath,
    "Confirm session mutation.",
  );
  const nodes: AgentRegistryNode[] = [worker, scout];
  let listener: ((event: RegistryEvent) => void) | undefined;
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
      listener = next;
      return () => {
        if (listener === next) listener = undefined;
      };
    }),
    remove: vi.fn(async () => undefined),
  } as unknown as AgentSessionRegistry;
  return {
    registry,
    emit(event) {
      listener?.(event);
    },
    worker,
    scout,
  };
}

function setup(overrides: Partial<SubagentProviderOptions> = {}) {
  const fixture = registryFixture();
  const provider = createSubagentProvider({
    registry: fixture.registry,
    ...overrides,
  });
  return { provider, fixture };
}

function cursor(epoch: string, sequence: number): FeedCursor {
  return { epoch, sequence };
}

describe("SubagentProvider snapshot and replay", () => {
  it("publishes a root-relative snapshot with its provider cursor at the boundary", () => {
    const { provider } = setup();
    const snapshot = provider.snapshot();

    expect(snapshot.cursor).toEqual({
      epoch: expect.any(String),
      sequence: expect.any(Number),
    });
    expect(snapshot.nodes.map((node) => node.path)).toEqual([
      workerPath,
      scoutPath,
    ]);
  });

  it("replays ordered semantic events after an observed cursor", () => {
    const { provider } = setup();
    const boundary = provider.snapshot().cursor;
    const replay: ReplayResult = provider.replay(boundary);

    expect(replay.kind).toBe("events");
    if (replay.kind === "events") {
      expect(replay.cursor.sequence).toBeGreaterThanOrEqual(boundary.sequence);
      expect(replay.events.map((item) => item.cursor.sequence)).toEqual(
        [...replay.events]
          .map((item) => item.cursor.sequence)
          .sort((a, b) => a - b),
      );
    }
  });

  it("requires a fresh snapshot when a replay cursor belongs to another epoch", () => {
    const { provider } = setup();
    const replay = provider.replay(cursor("stale-epoch", 42));

    expect(replay).toEqual({
      kind: "snapshot_required",
      reason: "epoch_changed",
    });
  });

  it("requires a fresh snapshot when the requested history is no longer retained", () => {
    const { provider } = setup();
    const boundary = provider.snapshot().cursor;
    const replay = provider.replay(cursor(boundary.epoch, -1));

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

  it("acquires the native child session through a path-scoped lease", async () => {
    const { provider } = setup();
    const lease = await provider.acquire(scoutPath);

    expect(lease.path).toEqual(scoutPath);
    expect(lease.session.sessionId).toEqual("session-scout");
    expect(lease.session).not.toHaveProperty("dispose");
    await lease.release();
    await lease.release();
  });

  it("reports teardown by public path without exposing runtime disposal", async () => {
    const { provider } = setup();
    const result = await provider.teardown(scoutPath);

    expect(result.path).toEqual(scoutPath);
    expect(result.removed).toBe(true);
    expect(result).toHaveProperty("sessionId");
  });
});
