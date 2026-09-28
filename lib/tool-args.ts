/**
 * Loosen optional tool parameters: an explicitly provided value equal to the
 * parameter type's degenerate default is treated as omission.
 *
 * Models tuned to harnesses that always commit optional parameters emit empty
 * values instead of omitting the field — `agent: ""` for an optional string,
 * `agents: []` for an optional array, `await: false` where the default is
 * already false. pi core validation already handles `null` (dropped for
 * optional properties) and string/number/boolean conversions; this pass covers
 * the remaining degenerate values, schema-driven so it needs no per-tool
 * knowledge:
 *
 * - `""` → dropped (the string default; pure garbage for every other type)
 * - `[]` → dropped (the array default)
 * - `false` → dropped when the declared type is boolean
 * - `{}` → dropped when the declared type is object
 *
 * Numbers are exempt beyond `""`: a real number always carries information
 * (`maxCharacters: 0` is not the same as omitted), so only the empty string is
 * dropped. Required properties are never dropped, but their values are
 * normalized recursively (object properties, array items) so nested optional
 * fields — e.g. `agents[].agent: ""` — are cleaned too.
 *
 * The normalizer runs via the tool definition's `prepareArguments` hook, which
 * the agent loop applies before schema validation; use `registerLooseTool` as
 * the `pi.registerTool` adapter.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Declared JSON-Schema types of a schema node, descending into unions. */
function declaredTypes(schema: unknown): string[] {
	const types: string[] = [];
	if (!isPlainObject(schema)) return types;
	if (typeof schema.type === "string") types.push(schema.type);
	else if (Array.isArray(schema.type)) {
		types.push(...schema.type.filter((t): t is string => typeof t === "string"));
	}
	for (const unionKey of ["anyOf", "oneOf"] as const) {
		if (Array.isArray(schema[unionKey])) {
			for (const member of schema[unionKey]) types.push(...declaredTypes(member));
		}
	}
	return types;
}

/** True when the value is the degenerate default of the property's type. */
function isEmptyForType(schema: unknown, value: unknown): boolean {
	if (value === "") return true;
	if (Array.isArray(value)) return value.length === 0;
	const types = declaredTypes(schema);
	if (value === false && types.includes("boolean")) return true;
	if (isPlainObject(value) && Object.keys(value).length === 0 && types.includes("object")) return true;
	return false;
}

function normalizeNode(schema: unknown, value: unknown): unknown {
	if (isPlainObject(value)) {
		const s = isPlainObject(schema) ? schema : {};
		const properties = isPlainObject(s.properties) ? s.properties : undefined;
		const required = new Set<string>(Array.isArray(s.required) ? s.required : []);
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			const propertySchema = properties?.[key];
			// Undeclared keys pass through untouched; schema validation owns them.
			if (!isPlainObject(propertySchema)) {
				out[key] = item;
				continue;
			}
			if (!required.has(key) && isEmptyForType(propertySchema, item)) continue;
			out[key] = normalizeNode(propertySchema, item);
		}
		return out;
	}
	if (Array.isArray(value)) {
		const items = isPlainObject(schema) ? schema.items : undefined;
		// Tuple item schemas are positional; leave them alone.
		if (!isPlainObject(items) || Array.isArray(items)) return value;
		return value.map((item) => normalizeNode(items, item));
	}
	return value;
}

/**
 * Drop optional properties whose value is the degenerate default of their
 * type. Returns a new object; the input is never mutated.
 */
export function dropEmptyOptionals(schema: TSchema, args: unknown): unknown {
	return normalizeNode(schema, args);
}

/**
 * `pi.registerTool` adapter that treats empty optional parameters as omission
 * by wiring `dropEmptyOptionals` into the definition's `prepareArguments`.
 */
export function registerLooseTool<T extends TSchema>(pi: ExtensionAPI, definition: ToolDefinition<T>): void {
	pi.registerTool({
		...definition,
		prepareArguments: (args: unknown) => dropEmptyOptionals(definition.parameters, args) as Static<T>,
	});
}
