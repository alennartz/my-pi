import type { SessionTreeStore } from "../../../lib/session-tree-store.js";

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
