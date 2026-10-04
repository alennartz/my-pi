/**
 * Autoflow Autostart Extension
 *
 * Opt-in (see config.ts): when `~/.pi/agent/autoflow.json` sets
 * `"autoStart": true`, a new session's first user message is sent as if the
 * user had invoked autoflow on it — the `input` event rewrites the message to
 * `<autoflow command> <message>` and pi expands it into a single skill
 * invocation, message appended.
 *
 * Only the root session of a genuinely new session arms; subagent child
 * sessions (which load this same extension) never autostart.
 */

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSubagentChildSession } from "../subagents/child-session-marker.ts";
import { DEFAULT_AUTOFLOW_COMMAND, loadAutoflowConfig } from "./config.ts";
import { planInput, shouldArm } from "./trigger.ts";

export default function autoflowAutostart(pi: ExtensionAPI) {
	let armed = false;
	let command = DEFAULT_AUTOFLOW_COMMAND;

	pi.on("session_start", (event, ctx) => {
		const { config, warning } = loadAutoflowConfig(getAgentDir());
		command = config.command;
		if (warning) ctx.ui.notify(warning, "warning");
		armed = shouldArm({
			reason: event.reason,
			hasPriorMessages: ctx.sessionManager.getEntries().some(
				(entry) => entry.type === "message" || entry.type === "custom_message",
			),
			isSubagentChild: isSubagentChildSession(ctx.sessionManager),
			autoStart: config.autoStart,
		});
	});

	pi.on("input", (event) => {
		const plan = planInput(armed, {
			text: event.text,
			...(event.streamingBehavior !== undefined ? { streamingBehavior: event.streamingBehavior } : {}),
			command,
		});
		armed = plan.armed;
		if (plan.action.kind === "transform") {
			return { action: "transform", text: plan.action.text, images: event.images };
		}
		return { action: "continue" };
	});
}
