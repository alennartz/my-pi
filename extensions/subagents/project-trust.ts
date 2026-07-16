import type {
	DefaultProjectTrust,
	ExtensionError,
	LoadExtensionsResult,
	ProjectTrustContext,
	ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";

/** Inputs needed to resolve project trust for one non-root child session. */
export type ChildProjectTrustOptions = {
	cwd: string;
	extensionsResult: LoadExtensionsResult;
	trustStore: Pick<ProjectTrustStore, "get" | "set">;
	defaultProjectTrust?: DefaultProjectTrust;
	projectTrustContext: ProjectTrustContext;
	onExtensionError?: (error: ExtensionError) => void;
};

/**
 * Resolve child project trust without importing pi's private CLI implementation.
 *
 * A decisive project_trust extension result wins, followed by saved trust and
 * the configured default. An unresolved ask decision uses the supplied
 * non-interactive context rather than opening child UI.
 */
export async function resolveChildProjectTrust(
	options: ChildProjectTrustOptions,
): Promise<boolean> {
	const event = { type: "project_trust" as const, cwd: options.cwd };

	for (const extension of options.extensionsResult.extensions) {
		const handlers = extension.handlers.get("project_trust");
		if (!handlers) continue;

		for (const handler of handlers) {
			try {
				const result = await handler(event, options.projectTrustContext);
				if (!result || typeof result !== "object") continue;

				const trusted = (result as { trusted?: unknown }).trusted;
				if (trusted === "undecided") continue;
				if (trusted !== "yes" && trusted !== "no") continue;

				const decision = trusted === "yes";
				if ((result as { remember?: unknown }).remember === true) {
					options.trustStore.set(options.cwd, decision);
				}
				return decision;
			} catch (error) {
				const normalized = error instanceof Error ? error : new Error(String(error));
				options.onExtensionError?.({
					extensionPath: extension.path,
					event: "project_trust",
					error: normalized.message,
					stack: normalized.stack,
				});
				// A failing trust hook is non-decisive; continue with the next hook.
			}
		}
	}

	const savedDecision = options.trustStore.get(options.cwd);
	if (savedDecision !== null) return savedDecision;

	switch (options.defaultProjectTrust ?? "ask") {
		case "always":
			return true;
		case "never":
			return false;
		case "ask":
			// Child sessions are headless: never invoke dialog methods here.
			return false;
	}
}
