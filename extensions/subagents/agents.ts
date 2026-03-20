/**
 * Agent discovery and configuration.
 *
 * Forked from examples/extensions/subagent/agents.ts, extended with:
 * - `skills` field in AgentConfig (parsed from frontmatter, comma-separated)
 * - resolveSkillPaths() — resolves skill names to filesystem paths via pi.getCommands()
 * - buildAgentArgs() — builds CLI args for spawning agent processes
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";

export interface RegularAgentSpec {
	kind: "agent";
	id: string;
	agent?: string;
	task: string;
	channels?: string[];
}

export interface ForkAgentSpec {
	kind: "fork";
	id: string;
	task: string;
	sessionFile: string;
	tools: string[];
	skillPaths: string[];
	thinkingLevel: string;
}

export type AgentSpec = RegularAgentSpec | ForkAgentSpec;

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	skills?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

		if (!frontmatter.name || !frontmatter.description) continue;

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		const skills = frontmatter.skills
			?.split(",")
			.map((s: string) => s.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			skills: skills && skills.length > 0 ? skills : undefined,
			model: frontmatter.model,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = loadAgentsFromDir(userDir, "user");
	const projectAgents = projectAgentsDir ? loadAgentsFromDir(projectAgentsDir, "project") : [];

	const agentMap = new Map<string, AgentConfig>();
	for (const agent of userAgents) agentMap.set(agent.name, agent);
	for (const agent of projectAgents) agentMap.set(agent.name, agent);

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}

export interface CommandInfo {
	name: string;
	source: string;
	path?: string;
}

/**
 * Resolve skill names to filesystem paths using pi.getCommands() output.
 * Throws if any skill name doesn't resolve.
 */
export function resolveSkillPaths(
	skillNames: string[],
	commands: CommandInfo[],
): string[] {
	const skillCommands = commands.filter((c) => c.source === "skill");
	const paths: string[] = [];

	for (const name of skillNames) {
		// Skills are prefixed with "skill:" in the commands list
		const cmd = skillCommands.find((c) => c.name === `skill:${name}` || c.name === name);
		if (!cmd?.path) {
			const available = skillCommands.map((c) => c.name.replace(/^skill:/, "")).join(", ");
			throw new Error(`Skill "${name}" not found. Available skills: ${available || "none"}`);
		}
		paths.push(cmd.path);
	}

	return paths;
}

/**
 * Build CLI args for spawning a pi child process for this agent.
 */
export function buildAgentArgs(agent: AgentConfig | undefined, skillPaths: string[], sessionDir: string): string[] {
	const args: string[] = ["--session-dir", sessionDir];
	if (agent?.model) args.push("--model", agent.model);
	if (agent?.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	if (skillPaths.length > 0) {
		args.push("--no-skills");
		for (const p of skillPaths) {
			args.push("--skill", p);
		}
	}
	return args;
}
