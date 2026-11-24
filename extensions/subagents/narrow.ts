/**
 * Narrowing helpers for payloads the SDK types as `any` or leaves undeclared.
 *
 * Each helper takes `unknown` and returns a typed value or `undefined`, so a
 * caller reads a field only after the check that justifies it.
 */
import type { JsonValue } from "@earendil-works/pi-ai";

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

/** Whether a value is a non-array object. */
export function isObjectLike(value: unknown): value is object {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A JSON object value. */
export type JsonObject = Record<string, JsonValue>;

/** True when a value survives a JSON round trip unchanged in shape. */
export function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") {return true;}
	if (typeof value === "number") {return Number.isFinite(value);}
	if (Array.isArray(value)) {return value.every((item) => isJsonValue(item));}
	const record = asRecord(value);
	return record !== undefined && Object.values(record).every((item) => isJsonValue(item));
}

/** Whether a value is a JSON object with JSON values only. */
export function isJsonObject(value: unknown): value is JsonObject {
	const record = asRecord(value);
	return record !== undefined && Object.values(record).every((item) => isJsonValue(item));
}

/**
 * Structural JSON projection of a data payload.
 *
 * Reads own enumerable members and recurses. Values that JSON cannot carry
 * become null, so the result is always safe to serialize and to type as
 * `JsonValue`.
 */
export function toJsonProjection(value: unknown): JsonValue {
	if (isJsonValue(value)) {return value;}
	if (Array.isArray(value)) {return value.map((item) => toJsonProjection(item));}
	if (!isObjectLike(value)) {return null;}
	const record: JsonObject = {};
	for (const key of Object.keys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		const member: unknown = descriptor?.value;
		if (member === undefined) {continue;}
		record[key] = toJsonProjection(member);
	}
	return record;
}

/** Parse JSON text into a validated value, or undefined when it is not JSON. */
export function parseJsonValue(text: string): JsonValue | undefined {
	try {
		const parsed: unknown = JSON.parse(text);
		return isJsonValue(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** Whether a JSON value is an array of JSON values. */
export function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
	return Array.isArray(value);
}
