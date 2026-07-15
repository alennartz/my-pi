import type {
	DefaultProjectTrust,
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
};

/**
 * Resolve child project trust without importing pi's private CLI implementation.
 *
 * A decisive project_trust extension result wins, followed by saved trust and
 * the configured default. An unresolved ask decision uses the supplied
 * non-interactive context rather than opening child UI.
 */
export function resolveChildProjectTrust(
	_options: ChildProjectTrustOptions,
): Promise<boolean> {
	throw new Error("not implemented");
}
