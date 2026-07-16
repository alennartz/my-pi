export type ChildToolPolicyInput =
	| { kind: "default" }
	| { kind: "persona"; tools: string[] }
	| { kind: "fork"; parentActiveTools: string[] };

export type ChildToolPolicy =
	| { allowedTools: undefined; excludeTools: ["ask_user"] }
	| { allowedTools: string[]; excludeTools: undefined };

/** Normalize one child session's SDK-wide tool allow/deny policy. */
export function resolveChildToolPolicy(_input: ChildToolPolicyInput): ChildToolPolicy {
	throw new Error("not implemented");
}
