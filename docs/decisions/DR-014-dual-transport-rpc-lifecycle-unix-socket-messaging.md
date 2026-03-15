# DR-014: Dual-Transport Architecture — RPC for Lifecycle, Unix Socket for Messaging

## Status
Accepted

## Context
The subagents extension needs two kinds of communication with child agents: (1) process lifecycle management (spawning, task delivery, event streaming, shutdown) and (2) inter-agent message routing (send/respond between peers). Pi's RPC protocol (`--mode rpc`) provides a stable JSONL command/event interface over stdin/stdout but is a closed set — no custom message types can be multiplexed through it. AgentSession (in-process) was rejected for process isolation and setup complexity reasons. Mesh networking between children was rejected because deadlock detection requires a global view of pending blocking sends.

## Decision
Use two transports. RPC over stdin/stdout for lifecycle (spawn, prompt, abort, event streams). A Unix domain socket broker (hub-and-spoke) for all inter-agent messaging. Children connect to the parent's broker socket on startup; all `send`/`respond` messages route through the broker, which enforces channels, detects deadlocks, and tracks agent liveness. The socket path is passed to children via the `PI_SUBAGENT` env var.

## Consequences
Clean separation of concerns — RPC handles what it was designed for, the broker handles the custom inter-agent protocol. Hub-and-spoke gives a single authority for channel enforcement, deadlock detection (global directed graph), and synthetic error responses when agents die — no distributed coordination needed. Tradeoff: an extra transport to maintain, and the broker is a single point of failure (mitigated by managed lifecycle — the broker lives in the parent process alongside the group manager). If pi's RPC protocol ever gains custom message support, the broker could be simplified, but the centralized enforcement benefits of hub-and-spoke would still justify the architecture.
