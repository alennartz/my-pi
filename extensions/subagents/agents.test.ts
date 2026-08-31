import { describe, expect, it } from "vitest";
import { renderAgentDefinitions, type AgentConfig } from "./agents.js";

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
