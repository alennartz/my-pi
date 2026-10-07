import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkspacePersona, parsePersonaDeclaration } from "./declaration.ts";

function agentsMd(frontMatter: string[], body: string): string {
	return `---\n${frontMatter.join("\n")}\n---\n\n${body}\n`;
}

describe("parsePersonaDeclaration", () => {
	it("parses a full persona declaration", () => {
		const content = agentsMd(
			[
				"kind: persona",
				"name: scout",
				'description: "Read-only codebase explorer"',
				"tools: read, bash, edit",
				"model: cheap",
				"skills: codemap, debugging",
			],
			"You are a scout — a read-only codebase exploration agent.",
		);

		const result = parsePersonaDeclaration(content, "/ws/AGENTS.md");

		expect(result).toEqual({
			kind: "persona",
			name: "scout",
			description: "Read-only codebase explorer",
			tools: ["read", "bash", "edit"],
			model: "cheap",
			skills: ["codemap", "debugging"],
			body: expect.stringContaining("You are a scout"),
			sourcePath: "/ws/AGENTS.md",
		});
	});

	it("keeps the markdown body below the front matter as the persona preamble", () => {
		const content = agentsMd(
			["kind: persona", "name: lead"],
			"# Lead\n\nFirst paragraph.\n\nSecond paragraph with `code`.\n",
		);

		const result = parsePersonaDeclaration(content, "/ws/AGENTS.md");

		expect(result?.body).toContain("# Lead");
		expect(result?.body).toContain("First paragraph.");
		expect(result?.body).toContain("Second paragraph with `code`.");
	});

	it("keeps the model ref raw, including a thinking-level suffix", () => {
		const content = agentsMd(
			["kind: persona", "name: deep", "model: anthropic/claude-opus-4-8:xhigh"],
			"Body.",
		);

		expect(parsePersonaDeclaration(content, "/ws/AGENTS.md")?.model).toBe(
			"anthropic/claude-opus-4-8:xhigh",
		);
	});

	it("splits comma-separated tools and skills into lists", () => {
		const content = agentsMd(
			["kind: persona", "name: pair", "tools: read, bash", "skills: codemap"],
			"Body.",
		);

		const result = parsePersonaDeclaration(content, "/ws/AGENTS.md");

		expect(result?.tools).toEqual(["read", "bash"]);
		expect(result?.skills).toEqual(["codemap"]);
	});

	it("leaves optional fields absent when the front matter omits them", () => {
		const content = agentsMd(["kind: persona", "name: minimal"], "Body.");

		const result = parsePersonaDeclaration(content, "/ws/AGENTS.md");

		expect(result).toEqual({
			kind: "persona",
			name: "minimal",
			body: expect.any(String),
			sourcePath: "/ws/AGENTS.md",
		});
	});

	it("returns undefined for content without front matter", () => {
		expect(parsePersonaDeclaration("# Just a README\n", "/ws/AGENTS.md")).toBeUndefined();
	});

	it("returns undefined for a plain project AGENTS.md without kind: persona", () => {
		const content = agentsMd(["name: my-project", "description: conventions"], "Project rules.");

		expect(parsePersonaDeclaration(content, "/ws/AGENTS.md")).toBeUndefined();
	});

	it("returns undefined when name and description look like an agent but kind is absent", () => {
		const content = agentsMd(
			["name: scout", "description: explorer", "tools: read"],
			"You are a scout.",
		);

		expect(parsePersonaDeclaration(content, "/ws/AGENTS.md")).toBeUndefined();
	});

	it("silently ignores unknown kind values", () => {
		const content = agentsMd(["kind: project", "name: thing"], "Body.");

		expect(parsePersonaDeclaration(content, "/ws/AGENTS.md")).toBeUndefined();
	});

	it("demands the exact kind marker", () => {
		const content = agentsMd(["kind: Persona", "name: scout"], "Body.");

		expect(parsePersonaDeclaration(content, "/ws/AGENTS.md")).toBeUndefined();
	});

	it("returns undefined when a persona marker lacks a name", () => {
		const content = agentsMd(["kind: persona", "description: explorer"], "Body.");

		expect(parsePersonaDeclaration(content, "/ws/AGENTS.md")).toBeUndefined();
	});

	it("returns undefined when the name is empty", () => {
		const content = agentsMd(["kind: persona", "name:"], "Body.");

		expect(parsePersonaDeclaration(content, "/ws/AGENTS.md")).toBeUndefined();
	});
});

describe("loadWorkspacePersona", () => {
	function workspaceWith(fileContents: string | Record<string, string>): string {
		const dir = mkdtempSync(join(tmpdir(), "persona-workspaces-"));
		if (typeof fileContents === "string") {
			writeFileSync(join(dir, "AGENTS.md"), fileContents);
		} else {
			for (const [rel, contents] of Object.entries(fileContents)) {
				const target = join(dir, rel);
				mkdirSync(join(target, ".."), { recursive: true });
				writeFileSync(target, contents);
			}
		}
		return dir;
	}

	it("loads the persona declared by the cwd's own AGENTS.md", () => {
		const cwd = workspaceWith(agentsMd(["kind: persona", "name: scout"], "You are a scout."));

		const result = loadWorkspacePersona(cwd);

		expect(result?.name).toBe("scout");
		expect(result?.sourcePath).toBe(join(cwd, "AGENTS.md"));
	});

	it("returns undefined when the cwd has no AGENTS.md", () => {
		const cwd = workspaceWith({ "NOTES.md": "nothing here" });

		expect(loadWorkspacePersona(cwd)).toBeUndefined();
	});

	it("does not walk ancestors for a persona", () => {
		const parent = mkdtempSync(join(tmpdir(), "persona-workspaces-"));
		writeFileSync(join(parent, "AGENTS.md"), agentsMd(["kind: persona", "name: scout"], "Body."));
		const cwd = join(parent, "sub");
		mkdirSync(cwd);

		expect(loadWorkspacePersona(cwd)).toBeUndefined();
	});

	it("does not recurse into subdirectories for a persona", () => {
		const cwd = workspaceWith({
			"AGENTS.md": "# Plain project context\n",
			"inner/AGENTS.md": agentsMd(["kind: persona", "name: hidden"], "Body."),
		});

		expect(loadWorkspacePersona(cwd)).toBeUndefined();
	});

	it("leaves a non-persona cwd AGENTS.md entirely alone", () => {
		const cwd = workspaceWith(agentsMd(["name: my-project"], "Project rules."));

		expect(loadWorkspacePersona(cwd)).toBeUndefined();
	});
});
