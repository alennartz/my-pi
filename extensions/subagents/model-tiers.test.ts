import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	TIER_NAMES,
	isTierName,
	loadTierConfig,
	renderTierTable,
	resolveModelRef,
	type TierConfig,
} from "./model-tiers.js";

// ─── isTierName ──────────────────────────────────────────────────────────────

describe("isTierName", () => {
	it("recognizes each of the four tier names", () => {
		for (const name of ["cheap", "medium", "smart", "frontier"]) {
			expect(isTierName(name)).toBe(true);
		}
	});

	it("rejects concrete model ids and arbitrary strings", () => {
		expect(isTierName("gpt-5.4")).toBe(false);
		expect(isTierName("anthropic/claude-opus-4-8")).toBe(false);
		expect(isTierName("fast")).toBe(false);
	});

	it("rejects the empty string", () => {
		expect(isTierName("")).toBe(false);
	});

	it("is case-sensitive — capitalized tier names are not tiers", () => {
		expect(isTierName("Cheap")).toBe(false);
		expect(isTierName("FRONTIER")).toBe(false);
	});
});

// ─── loadTierConfig ──────────────────────────────────────────────────────────

describe("loadTierConfig", () => {
	let tmpRoot: string;
	let globalPath: string;
	let projectPath: string;

	beforeEach(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "model-tiers-test-"));
		globalPath = path.join(tmpRoot, "agent", "model-tiers.json");
		projectPath = path.join(tmpRoot, "project", ".pi", "model-tiers.json");
	});

	afterEach(() => {
		try {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		} catch {
			// best effort
		}
	});

	function writeConfig(filePath: string, content: string): void {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, content);
	}

	function load(projectTrusted = true): TierConfig {
		return loadTierConfig({ globalPath, projectPath, projectTrusted });
	}

	it("returns an empty config when neither file exists", () => {
		expect(load()).toEqual({});
	});

	it("loads tiers from the global config when only it exists", () => {
		writeConfig(globalPath, JSON.stringify({ cheap: "gpt-5.4-mini", smart: "claude-opus-4-8" }));
		expect(load()).toEqual({ cheap: "gpt-5.4-mini", smart: "claude-opus-4-8" });
	});

	it("loads tiers from the project config when only it exists", () => {
		writeConfig(projectPath, JSON.stringify({ frontier: "gpt-5.4-pro" }));
		expect(load()).toEqual({ frontier: "gpt-5.4-pro" });
	});

	it("overlays project entries on top of global entries per key", () => {
		writeConfig(globalPath, JSON.stringify({ cheap: "gpt-5.4-mini", smart: "claude-opus-4-8" }));
		writeConfig(projectPath, JSON.stringify({ smart: "gpt-5.3-codex" }));
		expect(load()).toEqual({ cheap: "gpt-5.4-mini", smart: "gpt-5.3-codex" });
	});

	it("ignores the project config when the project is not trusted", () => {
		writeConfig(globalPath, JSON.stringify({ cheap: "gpt-5.4-mini" }));
		writeConfig(projectPath, JSON.stringify({ cheap: "evil-model", smart: "evil-model" }));
		expect(load(false)).toEqual({ cheap: "gpt-5.4-mini" });
	});

	it("tolerates unparseable JSON in one file and still uses the other", () => {
		writeConfig(globalPath, "{ not json !!");
		writeConfig(projectPath, JSON.stringify({ medium: "claude-sonnet-4-6" }));
		expect(load()).toEqual({ medium: "claude-sonnet-4-6" });
	});

	it("returns empty config when both files are unparseable, without throwing", () => {
		writeConfig(globalPath, "nope");
		writeConfig(projectPath, "[1,2,");
		expect(load()).toEqual({});
	});

	it("drops non-string values but keeps valid entries from the same file", () => {
		writeConfig(globalPath, JSON.stringify({ cheap: 42, medium: null, smart: "claude-opus-4-8" }));
		expect(load()).toEqual({ smart: "claude-opus-4-8" });
	});

	it("drops unknown tier keys but keeps known ones", () => {
		writeConfig(globalPath, JSON.stringify({ turbo: "gpt-5.4", cheap: "gpt-5.4-mini" }));
		const config = load();
		expect(config).toEqual({ cheap: "gpt-5.4-mini" });
		expect(config).not.toHaveProperty("turbo");
	});

	it("tolerates a JSON file whose top level is not an object", () => {
		writeConfig(globalPath, JSON.stringify(["cheap", "gpt-5.4-mini"]));
		expect(load()).toEqual({});
	});
});

// ─── resolveModelRef ─────────────────────────────────────────────────────────

describe("resolveModelRef", () => {
	const always = () => true;
	const never = () => false;

	it("resolves a configured tier to its model id when the model is available", () => {
		const result = resolveModelRef("smart", { smart: "claude-opus-4-8" }, always);
		expect(result.model).toBe("claude-opus-4-8");
		expect(result.warning).toBeUndefined();
	});

	it("resolves an unconfigured tier to undefined without a warning", () => {
		const result = resolveModelRef("frontier", { smart: "claude-opus-4-8" }, always);
		expect(result.model).toBeUndefined();
		expect(result.warning).toBeUndefined();
	});

	it("resolves a tier from an entirely empty config to undefined without a warning", () => {
		const result = resolveModelRef("cheap", {}, always);
		expect(result.model).toBeUndefined();
		expect(result.warning).toBeUndefined();
	});

	it("resolves a configured tier whose model is unavailable to undefined with a warning", () => {
		const result = resolveModelRef("smart", { smart: "gone-model" }, never);
		expect(result.model).toBeUndefined();
		expect(result.warning).toBeTruthy();
	});

	it("mentions the unavailable model in the warning", () => {
		const result = resolveModelRef("smart", { smart: "gone-model" }, never);
		expect(result.warning).toContain("gone-model");
	});

	it("passes a non-tier ref through unchanged", () => {
		const result = resolveModelRef("gpt-5.4", { cheap: "gpt-5.4-mini" }, always);
		expect(result.model).toBe("gpt-5.4");
		expect(result.warning).toBeUndefined();
	});

	it("passes a non-tier ref through even when it is unavailable — validation is the caller's job", () => {
		const result = resolveModelRef("made-up-model", {}, never);
		expect(result.model).toBe("made-up-model");
		expect(result.warning).toBeUndefined();
	});

	it("consults availability with the configured model id", () => {
		const seen: string[] = [];
		resolveModelRef("cheap", { cheap: "gpt-5.4-mini" }, (ref) => {
			seen.push(ref);
			return true;
		});
		expect(seen).toContain("gpt-5.4-mini");
	});
});

// ─── renderTierTable ─────────────────────────────────────────────────────────

describe("renderTierTable", () => {
	const always = () => true;
	const never = () => false;

	function tableText(tiers: TierConfig, isAvailable: (ref: string) => boolean, defaultModel = "session-default-model"): string {
		const lines = renderTierTable(tiers, isAvailable, defaultModel);
		expect(Array.isArray(lines)).toBe(true);
		return lines.join("\n");
	}

	it("includes a row for every tier name", () => {
		const text = tableText({}, always);
		for (const name of TIER_NAMES) {
			expect(text).toContain(name);
		}
	});

	it("shows the configured model id for a configured, available tier", () => {
		const text = tableText({ smart: "claude-opus-4-8" }, always);
		expect(text).toContain("claude-opus-4-8");
	});

	it("shows the session-default model with a (default) marker for unconfigured tiers", () => {
		const text = tableText({}, always, "gpt-5.4");
		expect(text).toContain("gpt-5.4");
		expect(text).toContain("(default)");
	});

	it("shows the session-default model with a (default) marker for a configured tier whose model is unavailable", () => {
		const text = tableText({ frontier: "gone-model" }, never, "gpt-5.4");
		expect(text).toContain("(default)");
		expect(text).toContain("gpt-5.4");
		expect(text).not.toContain("gone-model");
	});

	it("distinguishes configured and default tiers in a mixed config", () => {
		const lines = renderTierTable({ cheap: "gpt-5.4-mini" }, always, "gpt-5.4");
		const cheapLine = lines.find((l) => l.includes("cheap"));
		const frontierLine = lines.find((l) => l.includes("frontier"));
		expect(cheapLine).toBeDefined();
		expect(frontierLine).toBeDefined();
		expect(cheapLine!).toContain("gpt-5.4-mini");
		expect(cheapLine!).not.toContain("(default)");
		expect(frontierLine!).toContain("(default)");
	});
});
