# Test Review: In-process subagents

**Plan:** `docs/plans/in-process-subagents.md`
**Brainstorm:** `docs/brainstorms/in-process-subagents.md`
**Date:** 2026-07-15

## Summary

The initial tests covered the three new interfaces, but they did not yet protect the migration's observable-parity promise or several critical SDK lifecycle contracts. After a single approved decision batch, the suite now exercises the public scoped-extension, managed-session, and router seams; it uses deterministic SDK mocks for component behavior and one isolated real-SDK persisted-session fixture. The tests remain intentionally red because the interface implementations are still stubs; the runner launches all 33 topic tests without compilation or runner failures.

## Findings

### 1. Restricted scopes could register unplanned tools

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `extensions/subagents/scoped-extension.test.ts:35-91`
- **Status:** resolved

The original `arrayContaining` assertions proved that required tools were present, but allowed a child with a persona restriction to register any additional Subagents tool. The tests now assert exact root, unrestricted-child, and restricted-child surfaces. They also prove that a stale `PI_PARENT_LINK` cannot turn a root factory into a restricted child factory.

### 2. Router shutdown assertion contradicted accepted delivery

- **Category:** over-specified
- **Severity:** warning
- **Location:** `extensions/subagents/message-router.test.ts:301-323`
- **Status:** resolved

The old shutdown test sent a blocking message to a subscribed worker, then asserted that the listener had never run. Delivery occurs before `close()`, so that assertion contradicted the routing contract. The corrected test verifies the initial delivery, then verifies the actual shutdown contract: reject unresolved waits and future sends.

### 3. Managed-session tests depended on invalid live SDK setup

- **Category:** non-deterministic
- **Severity:** critical
- **Location:** `extensions/subagents/managed-child-session.test.ts:1-495`; `extensions/subagents/managed-child-session.integration.test.ts:1-76`
- **Status:** resolved

The original tests passed empty casts for auth/model infrastructure and nonexistent fixed paths into a future live SDK runtime. They could not deterministically verify session construction or safely clean up resources. The component suite now mocks only the SDK construction seam, asserts new/resume/fork mapping, configuration propagation, prompt preflight, headless binding, replacement, abort, and disposal, and cleans up every created child. A separate temporary-directory test uses the real SDK to require direct reopening of an RPC-era JSONL child session without identity or cwd migration.

### 4. Observable orchestration parity lacked integration coverage

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `extensions/subagents/scoped-extension.integration.test.ts:167-375`; `docs/plans/in-process-subagents.md:313-345`
- **Status:** resolved

The brainstorm requires parity for explicit child identity/uplink routing, dynamic membership, status/completion projection, persistence, teardown/resurrection, personas, models, skills, cwd behavior, widgets, and no-RPC ownership. The approved expansion adds scoped-child uplink and model-catalog tests plus root-orchestration tests with mocked managed sessions. They verify lifecycle settlement at `agent_settled`, replacement lifecycle records, dynamic addition, cooperative interruption, pre-start error settlement, resurrection, and persona-derived configuration without allowing RPC children or socket brokers.

### 5. Independent tool policies were undefined

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `extensions/subagents/managed-child-session.ts:24-35`; `extensions/subagents/scoped-extension.ts:10-24`; `docs/plans/in-process-subagents.md:73-80`
- **Status:** resolved

`scope.identity.tools` and `allowedTools` both carried tool lists, but their relationship was unspecified. The approved architecture now defines the former as the persona-derived Subagents-extension policy and the latter as the SDK-wide `--tools` policy; effective availability is their intersection. `respond` remains registered by the scoped factory but can be excluded by an explicit SDK-wide allowlist. Divergent-input tests cover both layers and universal `ask_user` exclusion.

### 6. Accepted router failures and correlation ownership were ambiguous

- **Category:** over-specified
- **Severity:** critical
- **Location:** `extensions/subagents/message-router.ts:5-38`; `extensions/subagents/message-router.test.ts:53-375`; `docs/plans/in-process-subagents.md:220-228`
- **Status:** resolved

The original tests treated accepted idle/cancel failures as promise rejections even though `RoutedResponse` includes a typed error variant and legacy synthetic failures are delivered after acceptance. They also left omitted/duplicate correlation IDs and responder ownership unspecified. The approved contract rejects only pre-delivery sends, resolves accepted cancel/lifecycle failures as `{ type: "error" }`, reserves rejection for router shutdown, allocates omitted IDs, rejects duplicates, and permits responses only from the addressed endpoint. The expanded router suite covers those rules, child-to-parent delivery, disconnected targets, detach/reverse work, multiple outstanding deadlock edges, sender removal, reconnection, and one-shot blocking-status callbacks.
