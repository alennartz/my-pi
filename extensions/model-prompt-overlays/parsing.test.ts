import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadOverlayFiles } from "./parsing.ts";
import type { ContextRoot } from "./discovery.ts";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "overlay-parsing-"));
}

describe("loadOverlayFiles", () => {
	const tempDirs: string[] = [];

	function createTemp(): string {
		const dir = makeTempDir();
		tempDirs.push(dir);
		return dir;
	}

	function makeRoot(dir: string): ContextRoot {
		return { dir, baseFilePath: join(dir, "AGENTS.md"), scope: "ancestor" };
	}

	afterEach(() => {
		for (const dir of tempDirs) {
			rmSync(dir, { recursive: true, force: true });
		}
		tempDirs.length = 0;
	});

	it("loads a valid single-glob overlay", () => {
		const dir = createTemp();
		writeFileSync(join(dir, "AGENTS.md"), "base");
		writeFileSync(join(dir, "AGENTS.claude.md"), "---\nmodels: claude-*\n---\nClaude-specific guidance");

		const { overlays, diagnostics } = loadOverlayFiles(makeRoot(dir));
		expect(diagnostics).toEqual([]);
		expect(overlays.length).toBe(1);
		expect(overlays[0].models).toEqual(["claude-*"]);
		expect(overlays[0].body).toContain("Claude-specific guidance");
		expect(overlays[0].path).toBe(join(dir, "AGENTS.claude.md"));
	});

	it("loads a valid multi-glob overlay", () => {
		const dir = createTemp();
		writeFileSync(join(dir, "AGENTS.md"), "base");
		writeFileSync(
			join(dir, "AGENTS.multi.md"),
			'---\nmodels:\n  - "claude-*"\n  - "gpt-*"\n---\nMulti-model guidance',
		);

		const { overlays, diagnostics } = loadOverlayFiles(makeRoot(dir));
		expect(diagnostics).toEqual([]);
		expect(overlays[0].models).toEqual(["claude-*", "gpt-*"]);
	});

	it("reports diagnostic for missing models field", () => {
		const dir = createTemp();
		writeFileSync(join(dir, "AGENTS.bad.md"), "---\ntitle: nope\n---\nBody");

		const { overlays, diagnostics } = loadOverlayFiles(makeRoot(dir));
		expect(overlays.length).toBe(0);
		expect(diagnostics.length).toBe(1);
		expect(diagnostics[0].message).toContain("Missing 'models'");
	});

	it("reports diagnostic for empty models array", () => {
		const dir = createTemp();
		writeFileSync(join(dir, "AGENTS.empty.md"), "---\nmodels: []\n---\nBody");

		const { overlays, diagnostics } = loadOverlayFiles(makeRoot(dir));
		expect(overlays.length).toBe(0);
		expect(diagnostics.length).toBe(1);
		expect(diagnostics[0].message).toContain("Empty 'models'");
	});

	it("reports diagnostic when models is a number", () => {
		const dir = createTemp();
		writeFileSync(join(dir, "AGENTS.numeric.md"), "---\nmodels: 42\n---\nBody");

		const { overlays, diagnostics } = loadOverlayFiles(makeRoot(dir));
		expect(overlays.length).toBe(0);
		expect(diagnostics.length).toBe(1);
		expect(diagnostics[0].message).toContain("Invalid 'models'");
	});

	it("excludes AGENTS.md (the base file)", () => {
		const dir = createTemp();
		writeFileSync(join(dir, "AGENTS.md"), "base file");

		const { overlays } = loadOverlayFiles(makeRoot(dir));
		expect(overlays.length).toBe(0);
	});

	it("excludes non-matching filenames like README.md and CLAUDE.md", () => {
		const dir = createTemp();
		writeFileSync(join(dir, "README.md"), "readme");
		writeFileSync(join(dir, "CLAUDE.md"), "claude");
		writeFileSync(join(dir, "agents.foo.md"), "lowercase");

		const { overlays } = loadOverlayFiles(makeRoot(dir));
		expect(overlays.length).toBe(0);
	});

	it("captures body text after frontmatter correctly", () => {
		const dir = createTemp();
		writeFileSync(
			join(dir, "AGENTS.test.md"),
			"---\nmodels: test-*\n---\nLine one\n\nLine two\n",
		);

		const { overlays } = loadOverlayFiles(makeRoot(dir));
		expect(overlays[0].body).toContain("Line one");
		expect(overlays[0].body).toContain("Line two");
	});

	it("returns overlays sorted alphabetically by filename", () => {
		const dir = createTemp();
		writeFileSync(join(dir, "AGENTS.z-model.md"), "---\nmodels: z-*\n---\nZ");
		writeFileSync(join(dir, "AGENTS.a-model.md"), "---\nmodels: a-*\n---\nA");

		const { overlays } = loadOverlayFiles(makeRoot(dir));
		expect(overlays[0].path).toContain("AGENTS.a-model.md");
		expect(overlays[1].path).toContain("AGENTS.z-model.md");
	});
});
