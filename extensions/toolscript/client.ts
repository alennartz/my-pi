import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface McpToolDef {
	name: string;
	description: string;
	inputSchema: object;
}

export interface StartResult {
	tools: McpToolDef[];
	instructions: string;
}

export interface CallToolResult {
	content: string;
	isError: boolean;
}

export class ToolscriptClient {
	private cwd: string;
	private client: Client | null = null;
	private transport: StdioClientTransport | null = null;
	private running = false;
	private restartPromise: Promise<void> | null = null;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	async start(): Promise<StartResult> {
		// Resolve binary
		const binary = process.env.TOOLSCRIPT_BIN ?? "toolscript";

		// Resolve config files
		const userConfig = join(homedir(), ".pi", "toolscript", "toolscript.toml");
		const projectConfig = join(this.cwd, "toolscript.toml");
		const configFiles: string[] = [];
		if (existsSync(userConfig)) configFiles.push(userConfig);
		if (existsSync(projectConfig)) configFiles.push(projectConfig);

		if (configFiles.length === 0) {
			throw new Error("No toolscript config found");
		}

		// Build args: toolscript run --config <file1> --config <file2>
		const args = ["run"];
		for (const configFile of configFiles) {
			args.push("--config", configFile);
		}

		// Create transport and client
		this.transport = new StdioClientTransport({
			command: binary,
			args,
			cwd: this.cwd,
			stderr: "inherit",
		});

		this.client = new Client({ name: "pi-toolscript", version: "1.0.0" });

		// Listen for process exit via transport close
		this.transport.onclose = () => {
			this.running = false;
		};

		// Connect (spawns child process, performs MCP initialize handshake)
		await this.client.connect(this.transport);
		this.running = true;

		// Get instructions
		const instructions = this.client.getInstructions() ?? "";

		// List tools
		const toolsResult = await this.client.listTools();
		const tools: McpToolDef[] = toolsResult.tools.map((tool) => ({
			name: tool.name,
			description: tool.description ?? "",
			inputSchema: tool.inputSchema,
		}));

		return { tools, instructions };
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
		// If process has crashed, restart and report error for the failed call
		if (!this.running) {
			if (!this.restartPromise) {
				this.restartPromise = this.start()
					.then(() => {})
					.finally(() => { this.restartPromise = null; });
			}
			try {
				await this.restartPromise;
			} catch (err) {
				return {
					content: `toolscript crashed and could not be restarted: ${err instanceof Error ? err.message : String(err)}`,
					isError: true,
				};
			}
			return {
				content: "toolscript crashed and has been restarted. The previous call was lost — please retry.",
				isError: true,
			};
		}

		try {
			const result = await this.client!.callTool({ name, arguments: args });

			// Extract text content
			const textParts: string[] = [];
			if (Array.isArray(result.content)) {
				for (const item of result.content) {
					if (typeof item === "object" && item !== null && "type" in item && item.type === "text" && "text" in item) {
						textParts.push(item.text as string);
					}
				}
			}

			return {
				content: textParts.join("\n"),
				isError: result.isError ?? false,
			};
		} catch (err) {
			return {
				content: `toolscript call failed: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	}

	async stop(): Promise<void> {
		if (!this.running) return;
		if (this.client) {
			await this.client.close();
		}
		this.running = false;
	}
}
