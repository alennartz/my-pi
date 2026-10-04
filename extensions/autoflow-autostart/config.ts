/**
 * Autoflow autostart configuration — `<agentDir>/autoflow.json`.
 *
 * Shape:
 * ```json
 * { "autoStart": true, "command": "/skill:autoflow" }
 * ```
 *
 * `autoStart` is the opt-in: when true, a new session's first user message is
 * sent as an autoflow invocation with the message appended. `command` is the
 * slash command that invokes autoflow and defaults to `/skill:autoflow`.
 *
 * Follows the package's config convention (cf. `model-tiers.json`,
 * `quota-providers.json`): a missing file means "opt-in is off", and a
 * malformed one degrades to defaults with a warning instead of failing.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_FILE_NAME = "autoflow.json";
export const DEFAULT_AUTOFLOW_COMMAND = "/skill:autoflow";

export interface AutoflowConfig {
	autoStart: boolean;
	command: string;
}

export interface ParsedAutoflowConfig {
	config: AutoflowConfig;
	warning?: string;
}

function defaults(): ParsedAutoflowConfig {
	return { config: { autoStart: false, command: DEFAULT_AUTOFLOW_COMMAND } };
}

function isCommand(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 1 &&
		value.startsWith("/") &&
		value.trim() === value
	);
}

/** Parse raw autoflow.json content. Pure: no I/O. */
export function parseAutoflowConfig(raw: string): ParsedAutoflowConfig {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			...defaults(),
			warning: `autoflow: failed to parse ${CONFIG_FILE_NAME}: ${msg}. Autostart stays disabled.`,
		};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return {
			...defaults(),
			warning: `autoflow: ${CONFIG_FILE_NAME} must contain a JSON object. Autostart stays disabled.`,
		};
	}

	const record = parsed as Record<string, unknown>;
	const warnings: string[] = [];

	let autoStart = false;
	if (record.autoStart !== undefined) {
		if (typeof record.autoStart === "boolean") autoStart = record.autoStart;
		else warnings.push(`autoflow: "autoStart" in ${CONFIG_FILE_NAME} must be a boolean; ignoring.`);
	}

	let command = DEFAULT_AUTOFLOW_COMMAND;
	if (record.command !== undefined) {
		if (isCommand(record.command)) command = record.command;
		else warnings.push(`autoflow: "command" in ${CONFIG_FILE_NAME} must be a slash command; using ${DEFAULT_AUTOFLOW_COMMAND}.`);
	}

	return {
		config: { autoStart, command },
		...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
	};
}

/** Read and parse `<agentDir>/autoflow.json`. A missing or unreadable file disables autostart. */
export function loadAutoflowConfig(agentDir: string): ParsedAutoflowConfig {
	let raw: string;
	try {
		raw = readFileSync(join(agentDir, CONFIG_FILE_NAME), "utf-8");
	} catch {
		return defaults();
	}
	return parseAutoflowConfig(raw);
}
