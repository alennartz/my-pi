import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_NAME_LENGTH = 200;

/** Match pi's session_info normalization: line breaks become spaces, trim. */
function normalizeName(raw: string): string {
	return raw.replace(/[\r\n]+/g, " ").trim();
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "set_session_name",
		label: "Set Session Name",
		description:
			"Set name of the current session once the task is clear. Keep the name short, <= 12 characters. Prefix with a two-letter code that represents the current working directory.",
		promptSnippet: "Name the session once the task is clear",
		promptGuidelines: [
			'Call set_session_name once the task is clear, with a short descriptive phrase (for example "fix webhook retry backoff").',
			"Call it again only when the task meaningfully changes; pass an empty string to clear the name.",
		],
		parameters: Type.Object({
			name: Type.String({
				description:
					"New session name. Line breaks become spaces and whitespace is trimmed. Pass an empty string to clear the name.",
			}),
		}),
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		async execute(_toolCallId, params) {
			const name = normalizeName(params.name);
			if (name.length > MAX_NAME_LENGTH) {
				throw new Error(`Session name must be at most ${MAX_NAME_LENGTH} characters, got ${name.length}.`);
			}

			const previous = pi.getSessionName();
			if (name === (previous ?? "")) {
				const text = previous
					? `Session name unchanged: ${JSON.stringify(previous)}`
					: "Session has no name and no name was given; nothing to do.";
				return {
					content: [{ type: "text" as const, text }],
					details: { name: previous ?? null, previous: previous ?? null },
				};
			}

			pi.setSessionName(name);
			// pi normalizes again and an empty name clears the title; report the
			// effective value rather than the raw argument.
			const effective = pi.getSessionName();
			const text = effective
				? `Session name set: ${JSON.stringify(effective)}`
				: `Session name cleared${previous ? ` (was ${JSON.stringify(previous)})` : ""}.`;
			return {
				content: [{ type: "text" as const, text }],
				details: { name: effective ?? null, previous: previous ?? null },
			};
		},
	});
}
