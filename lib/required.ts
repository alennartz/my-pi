/**
 * Return an expected value, or throw when it is missing.
 *
 * Callers use this where a lookup or index must yield a value by construction.
 * The throw replaces a non-null assertion with an explicit failure.
 */
export function required<T>(value: T | null | undefined, what: string): T {
	if (value === null || value === undefined) {
		throw new Error(`Missing ${what}`);
	}
	return value;
}
