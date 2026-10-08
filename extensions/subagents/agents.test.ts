import { describe, expect, it } from "vitest";
import { renderAgentDefinitions, resolvePersonaSkillPaths, type AgentConfig } from "./agents.js";

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "scout",
		description: "Locate code",
		systemPrompt: "Search only.",
		source: "user",
		filePath: "/agents/scout.md",
		...overrides,
	};
}

describe("renderAgentDefinitions", () => {
	it("renders a root element with one child agent element per definition", () => {
		expect(renderAgentDefinitions([
			agent(),
			agent({ name: "reviewer", description: "Review changes", source: "project" }),
		])).toBe([
			"<available_agent_definitions>",
			'  <agent name="scout" source="user">Locate code</agent>',
			'  <agent name="reviewer" source="project">Review changes</agent>',
			"</available_agent_definitions>",
		].join("\n"));
	});

	it("escapes names, sources, and descriptions for XML", () => {
		expect(renderAgentDefinitions([
			agent({
				name: 'reviewer "strict"',
				source: "package:user",
				description: "Check <files> & report 'findings'",
			}),
		])).toContain(
			'  <agent name="reviewer &quot;strict&quot;" source="package:user">Check &lt;files&gt; &amp; report &apos;findings&apos;</agent>',
		);
	});
});

describe("resolvePersonaSkillPaths", () => {
	const commands = [
		{ name: "skill:debugging", source: "skill", path: "/skills/debugging/SKILL.md" },
		{ name: "skill:review", source: "skill", path: "/skills/review/SKILL.md" },
		{ name: "plain", source: "project", path: "/commands/plain.md" },
	];

	it("resolves declared names in order under the fatal policy", () => {
		const result = resolvePersonaSkillPaths(["review", "debugging"], commands, "fatal");
		expect(result).toEqual({
			skillPaths: ["/skills/review/SKILL.md", "/skills/debugging/SKILL.md"],
			dropped: [],
		});
	});

	it("throws on an unresolvable name under the fatal policy", () => {
		expect(() => resolvePersonaSkillPaths(["debugging", "typo"], commands, "fatal")).toThrow(
			/Skill "typo" not found/,
		);
	});

	it("drops unresolvable names and reports them under the subset policy", () => {
		const result = resolvePersonaSkillPaths(["debugging", "typo", "review"], commands, "subset");
		expect(result).toEqual({
			skillPaths: ["/skills/debugging/SKILL.md", "/skills/review/SKILL.md"],
			dropped: ["typo"],
		});
	});

	it("yields zero skills, not failure, when an all-stale list degrades under the subset policy", () => {
		const result = resolvePersonaSkillPaths(["typo", "gone"], commands, "subset");
		expect(result).toEqual({ skillPaths: [], dropped: ["typo", "gone"] });
	});
});
