export type ChildToolPolicyInput =
	| { kind: "default" }
	| { kind: "persona"; tools: string[] }
	| { kind: "fork"; parentActiveTools: string[] };

export type ChildToolPolicy =
	| { allowedTools: undefined; excludeTools: ["ask_user"] }
	| { allowedTools: string[]; excludeTools: undefined };

/** Normalize one child session's SDK-wide tool allow/deny policy. */
export function resolveChildToolPolicy(input: ChildToolPolicyInput): ChildToolPolicy {
	if (input.kind === "default") {
		return {
			allowedTools: undefined,
			excludeTools: ["ask_user"],
		};
	}

	const tools = input.kind === "persona" ? input.tools : input.parentActiveTools;
	const allowedTools: string[] = [];
	const seen = new Set<string>();

	for (const tool of tools) {
		if (tool === "ask_user" || seen.has(tool)) continue;
		seen.add(tool);
		allowedTools.push(tool);
	}

	if (!seen.has("respond")) allowedTools.push("respond");

	return {
		allowedTools,
		excludeTools: undefined,
	};
}
