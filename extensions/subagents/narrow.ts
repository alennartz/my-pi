/**
 * Narrowing helpers for payloads the SDK types as `any` or leaves undeclared.
 *
 * Each helper takes `unknown` and returns a typed value or `undefined`, so a
 * caller reads a field only after the check that justifies it.
 */

/** A plain object view of an unknown value. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** A string field of an unknown value. */
export function stringField(value: unknown, key: string): string | undefined {
	const record = asRecord(value);
	const field = record?.[key];
	return typeof field === "string" ? field : undefined;
}

/** A finite number field of an unknown value. */
export function numberField(value: unknown, key: string): number | undefined {
	const record = asRecord(value);
	const field = record?.[key];
	return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

/** A boolean field of an unknown value. */
export function booleanField(value: unknown, key: string): boolean | undefined {
	const record = asRecord(value);
	const field = record?.[key];
	return typeof field === "boolean" ? field : undefined;
}

/** A string array field of an unknown value. */
export function stringArrayField(value: unknown, key: string): string[] | undefined {
	const record = asRecord(value);
	const field = record?.[key];
	return Array.isArray(field) ? field.filter((item): item is string => typeof item === "string") : undefined;
}
