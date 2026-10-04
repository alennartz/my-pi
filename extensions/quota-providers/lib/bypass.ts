import type { SessionTreeStore } from "../../../lib/session-tree-store.js";
import { getSessionIdTreeStore } from "../../subagents/scoped-store.js";

/** One tree-local key shared by every quota provider instance. */
export const BYPASS_KEY = "quota-providers.bypass";

/** Absent or non-boolean values are treated as bypass disabled. */
export function readBypass(store: SessionTreeStore): boolean {
	return store.get<unknown>(BYPASS_KEY) === true;
}

/** Store only an enabled flag; disabling removes the key entirely. */
export function writeBypass(store: SessionTreeStore, enabled: boolean): void {
	if (enabled) store.set(BYPASS_KEY, true);
	else store.delete(BYPASS_KEY);
}

/**
 * Resolve the tree store a provider request should read bypass from.
 *
 * A request carries `options.sessionId`, which identifies the tree making the
 * request even when the provider closure serving it was registered by another
 * session (the model runtime is shared across sessions in one host process).
 * The captured fallback covers requests that arrive without a session id.
 */
export function resolveRequestStore(
	sessionId: string | undefined,
	fallback: SessionTreeStore | undefined,
): SessionTreeStore | undefined {
	return (sessionId ? getSessionIdTreeStore(sessionId) : undefined) ?? fallback;
}
