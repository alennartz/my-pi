import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CONFIG_FILE_NAME,
	DEFAULT_AUTOFLOW_COMMAND,
	loadAutoflowConfig,
	parseAutoflowConfig,
} from "./config.ts";

describe("parseAutoflowConfig", () => {
	it("parses an enabled config", () => {
		const result = parseAutoflowConfig('{"autoStart": true}');
		expect(result.config).toEqual({ autoStart: true, command: DEFAULT_AUTOFLOW_COMMAND });
		expect(result.warning).toBeUndefined();
	});

	it("parses a custom invocation command", () => {
		const result = parseAutoflowConfig('{"autoStart": true, "command": "/flow"}');
		expect(result.config).toEqual({ autoStart: true, command: "/flow" });
	});

	it("defaults to opt-out", () => {
		expect(parseAutoflowConfig("{}").config).toEqual({
			autoStart: false,
			command: DEFAULT_AUTOFLOW_COMMAND,
		});
	});

	it("degrades to defaults with a warning on malformed JSON", () => {
		const result = parseAutoflowConfig("{nope");
		expect(result.config).toEqual({ autoStart: false, command: DEFAULT_AUTOFLOW_COMMAND });
		expect(result.warning).toContain("failed to parse");
	});

	it("rejects non-object JSON with a warning", () => {
		const result = parseAutoflowConfig("[1,2]");
		expect(result.config.autoStart).toBe(false);
		expect(result.warning).toContain("must contain a JSON object");
	});

	it("ignores a non-boolean autoStart with a warning", () => {
		const result = parseAutoflowConfig('{"autoStart": "yes"}');
		expect(result.config.autoStart).toBe(false);
		expect(result.warning).toContain('"autoStart"');
	});

	it.each(["not-a-command", "", "skill:autoflow", " /flow"])(
		"ignores the invalid command %j with a warning",
		(command) => {
			const result = parseAutoflowConfig(JSON.stringify({ autoStart: true, command }));
			expect(result.config.command).toBe(DEFAULT_AUTOFLOW_COMMAND);
			expect(result.warning).toContain('"command"');
		},
	);
});

describe("loadAutoflowConfig", () => {
	function agentDirWith(contents?: string): string {
		const dir = mkdtempSync(join(tmpdir(), "autoflow-config-"));
		if (contents !== undefined) writeFileSync(join(dir, CONFIG_FILE_NAME), contents);
		return dir;
	}

	it("reads the config file from the agent dir", () => {
		const dir = agentDirWith('{"autoStart": true}');
		expect(loadAutoflowConfig(dir).config).toEqual({
			autoStart: true,
			command: DEFAULT_AUTOFLOW_COMMAND,
		});
	});

	it("treats a missing file as opt-out", () => {
		const dir = agentDirWith();
		const result = loadAutoflowConfig(dir);
		expect(result.config.autoStart).toBe(false);
		expect(result.warning).toBeUndefined();
	});

	it("treats an unreadable path as opt-out", () => {
		expect(loadAutoflowConfig(join(tmpdir(), "does-not-exist-xyz")).config.autoStart).toBe(false);
	});
});
