/**
 * Key/value state scoped to one live agent tree.
 *
 * The subagents extension owns the implementation and lifecycle. Other
 * extensions depend only on this interface when storing tree-local state.
 */
export interface SessionTreeStore {
	get<T>(key: string): T | undefined;
	set<T>(key: string, value: T): void;
	delete(key: string): void;
	clear(): void;
}
