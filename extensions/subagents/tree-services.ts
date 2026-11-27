import type { SubagentControlPort } from "./control-port.js";
import type { RunningToolProgress } from "./tool-progress.js";

/** Root-scoped services every manager in one tree shares. */
export type SubagentTreeServices = Readonly<{
	control: SubagentControlPort;
	toolProgress: RunningToolProgress;
	/** Report a descendant restore. The provider turns ready once every reported restore ends. */
	trackRestore(restore: Promise<unknown>): void;
}>;
