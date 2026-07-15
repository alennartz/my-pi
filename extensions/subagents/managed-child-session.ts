import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
	AgentSession,
	AgentSessionEvent,
	AgentSessionRuntime,
	AuthStorage,
	EventBusController,
	ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { SubagentScope } from "./scoped-extension.js";

export type ChildSessionTarget =
	| { kind: "new"; cwd: string; sessionDir: string }
	| { kind: "resume"; sessionFile: string; sessionDir: string }
	| {
		kind: "fork";
		sourceSessionFile: string;
		cwd: string;
		sessionDir: string;
	};

export type ChildSessionConfig = {
	id: string;
	target: ChildSessionTarget;
	scope: Extract<SubagentScope, { kind: "child" }>;
	modelRef?: string;
	thinkingLevel?: ThinkingLevel;
	/**
	 * SDK-wide child-tool allowlist, corresponding to the legacy CLI `--tools`
	 * policy. It intersects with (but does not replace) scope.identity.tools.
	 */
	allowedTools?: string[];
	skillPaths: string[];
	appendSystemPrompt: string[];
};

export type ChildSessionHooks = {
	onEvent(event: AgentSessionEvent): void;
	onUiNotify(message: string, type?: "info" | "warning" | "error"): void;
	onSessionChanged(metadata: {
		sessionId: string;
		sessionFile?: string;
		cwd: string;
	}): void;
	onShutdownRequested(): void;
};

export type ManagedChildSessionDependencies = {
	agentDir: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
};

/**
 * Owns one SDK-native child runtime and its scoped extension lifecycle.
 *
 * The class deliberately exposes the AgentSessionRuntime so callers can use
 * SDK-native session replacement and lifecycle capabilities. Construction is
 * performed through createManagedChildSession so cwd-bound dependencies stay
 * behind this boundary.
 */
export class ManagedChildSession {
	readonly runtime!: AgentSessionRuntime;

	get eventBus(): EventBusController {
		throw new Error("not implemented");
	}

	get session(): AgentSession {
		throw new Error("not implemented");
	}

	get sessionId(): string {
		throw new Error("not implemented");
	}

	get sessionFile(): string | undefined {
		throw new Error("not implemented");
	}

	submit(
		_text: string,
		_streamingBehavior?: "steer" | "followUp",
	): Promise<void> {
		throw new Error("not implemented");
	}

	abort(): Promise<void> {
		throw new Error("not implemented");
	}

	dispose(): Promise<void> {
		throw new Error("not implemented");
	}
}

export function createManagedChildSession(
	_config: ChildSessionConfig,
	_dependencies: ManagedChildSessionDependencies,
	_hooks: ChildSessionHooks,
): Promise<ManagedChildSession> {
	throw new Error("not implemented");
}
