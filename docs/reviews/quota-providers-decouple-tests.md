# Test Review: Quota providers decoupling

**Plan:** `docs/plans/quota-providers-decouple.md`  
**Brainstorm:** `docs/brainstorms/quota-providers-decouple.md`  
**Date:** 2026-11-06

## Summary

The reviewed tests cover quota attachment, scoped accounting, DevPass windows, and Gateway catalog persistence. The registry tests exercise actual pi provider origins. The tests await implementation and fail against the current stubs and legacy extension.

## Findings

### 1. Provider attachments lacked registry coverage

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `extensions/quota-providers/attachment.integration.test.ts:36-103`
- **Status:** resolved

The original origin cases used one fake provider. They could not detect provider replacement or attachment failures. The user approved registry-level tests for built-in, `models.json`, legacy, and native providers, plus an unattached provider. The architecture now specifies the extension lifecycle and effective-registry boundary.

### 2. Cached membership did not reach quota decisions

- **Category:** missing coverage
- **Severity:** critical
- **Location:** `extensions/quota-providers/attachment.integration.test.ts:105-144`
- **Status:** resolved

The original tests stopped at the cache record. They did not prove that scoped limits, ledger entries, and bypass affect stream decisions. The user approved extension-boundary tests for global and scoped budgets, ledger membership, tree isolation, soft bypass, and hard-cap enforcement.

### 3. Stored Gateway catalogs lacked valid pi model records

- **Category:** over-specified
- **Severity:** critical
- **Location:** `extensions/llm-gateway/index.test.ts:58-102`
- **Status:** resolved

The original test equated persisted models with returned provider configurations. Pi stores full `AnyModel` records. The user approved a `ModelsStoreEntry` round-trip and separate assertions for refreshed, fresh, offline, stale, and forced catalogs. The architecture now specifies the persisted record and restoration conversion.

### 4. DevPass window and failure paths were missing

- **Category:** missing coverage
- **Severity:** warning
- **Location:** `extensions/quota-providers/impls/devpass-quota.test.ts:63-135`
- **Status:** resolved

The user approved deterministic checks for monthly and weekly bounds, an absent premium pool, invalid usage, and upstream failure. The tests freeze time and restore the environment after each case.

### 5. Provider method identity constrained delegation

- **Category:** over-specified
- **Severity:** warning
- **Location:** `extensions/quota-providers/lib/provider-wrapper.test.ts:37-53`
- **Status:** resolved

The original test required identical method references. A correct wrapper can bind or delegate methods instead. The user approved assertions on provider capabilities and their observable results.

### 6. Runner test uses the executable boundary

- **Category:** wrong abstraction
- **Severity:** warning
- **Location:** `extensions/quota-providers/runner-usage.test.ts:16-57`
- **Status:** dismissed

The test invokes the existing runner executable rather than a materialized TypeScript interface. The user approved this exception because the CLI is the out-of-band boundary. The test also checks ledger pruning.

### 7. Cache tests reused process-wide temporary paths

- **Category:** non-deterministic
- **Severity:** warning
- **Location:** `extensions/quota-providers/lib/usage-cache.test.ts:8-54`
- **Status:** resolved

The tests now create independent temporary directories and remove them after use. This prevents concurrent runs from sharing cache files.
