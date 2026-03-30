import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { getArtifactInventory, getGitStatus } from "./phases.ts";
import { showNumberedSelect } from "../../lib/components/numbered-select.ts";

// =============================================================================
// Constants
// =============================================================================

const PHASE_SKILL_MAP: Record<string, string> = {
	brainstorm: "brainstorming",
	architect: "architecting",
	"test-write": "test-writing",
	"test-review": "test-review",
	"impl-plan": "impl-planning",
	implement: "implementing",
	review: "code-review",
	"handle-review": "handle-review",
	cleanup: "cleanup",
};

const PHASE_ORDER = ["brainstorm", "architect", "test-write", "test-review", "impl-plan", "implement", "review", "handle-review", "cleanup"];

/** Phases where the user can choose to continue in the same context or start fresh */
const FLEXIBLE_TRANSITIONS = new Set(["brainstorm", "architect", "test-write", "review"]);

/** Maps each phase to the artifact path pattern it produces/validates */
const PHASE_ARTIFACTS: Record<string, (topic: string) => string> = {
	brainstorm: (topic) => `docs/brainstorms/${topic}.md`,
	architect: (topic) => `docs/plans/${topic}.md`,
	"test-write": (topic) => `docs/plans/${topic}.md`,
	"test-review": (topic) => `docs/reviews/${topic}-tests.md`,
	"impl-plan": (topic) => `docs/plans/${topic}.md`,
	implement: (topic) => `docs/plans/${topic}.md`,
	review: (topic) => `docs/reviews/${topic}.md`,
	"handle-review": (topic) => `docs/reviews/${topic}.md`,
};

// =============================================================================
// Prompt helpers
// =============================================================================

const promptTemplate = readFileSync(join(__dirname, "prompt.md"), "utf-8");

function buildEntryPrompt(userInput: string, inventory: string, gitStatus: string): string {
	return promptTemplate
		.replace("${USER_INPUT}", userInput || "(no input — pick up where we left off or ask)")
		.replace("${INVENTORY}", inventory)
		.replace("${GIT_STATUS}", gitStatus);
}

function buildPhasePrompt(topic: string, phase: string, cwd: string): string {
	const skill = PHASE_SKILL_MAP[phase];
	const gitStatus = getGitStatus(cwd);
	const lines = [
		`# Workflow: Continue Pipeline`,
		``,
		`**Topic:** \`${topic}\``,
		`**Phase:** \`${phase}\``,
		`**Skill:** \`${skill}\``,
		``,
		`## Working Tree Status`,
		``,
		gitStatus,
		``,
		`Load and follow the \`${skill}\` skill for the topic \`${topic}\`.`,
		``,
		`When the skill's work is done, call \`workflow_phase_complete\` with topic \`${topic}\` and phase \`${phase}\`.`,
		``,
		`Follow the skill's instructions for what to read. If you're uncertain about intent or context during a phase, you may consult earlier artifacts (brainstorm, plan) before asking the user — but don't read them by default.`,
	];
	return lines.join("\n");
}

function getNextPhase(current: string): string | null {
	const idx = PHASE_ORDER.indexOf(current);
	if (idx === -1 || idx === PHASE_ORDER.length - 1) return null;
	return PHASE_ORDER[idx + 1];
}

// =============================================================================
// Extension entry point
// =============================================================================

export default function (pi: ExtensionAPI) {
	// ── Pending transition state ──────────────────────────────────────────
	// Stored by the tool, consumed by agent_end to pre-fill the editor.
	// sendUserMessage() skips command processing (expandPromptTemplates: false),
	// so we can't trigger /internal-workflow-next from a tool. Instead, the tool
	// stores the transition here and agent_end pre-fills the editor with the
	// command for the user to send with Enter.
	let pendingTransition: { topic: string; phase: string } | null = null;

	// ── agent_end: auto-fill editor for pending transition ────────────────
	pi.on("agent_end", async (_event, ctx) => {
		if (!pendingTransition) return;
		const { topic, phase } = pendingTransition;
		pendingTransition = null;
		ctx.ui.setEditorText(`/internal-workflow-next ${topic} ${phase}`);
		ctx.ui.notify(`Press Enter to start ${phase} in a new session.`, "info");
	});

	// ── /workflow command ──────────────────────────────────────────────────
	pi.registerCommand("workflow", {
		description: "Start or continue the development workflow pipeline",
		handler: async (args, ctx) => {
			const inventory = getArtifactInventory(ctx.cwd);
			const gitStatus = getGitStatus(ctx.cwd);
			const prompt = buildEntryPrompt(args, inventory, gitStatus);
			pi.sendUserMessage(prompt);
		},
	});

	// ── /internal-workflow-next command ────────────────────────────────────
	// Invoked by the user pressing Enter after agent_end pre-fills the editor.
	// Has ExtensionCommandContext so newSession() works.
	pi.registerCommand("internal-workflow-next", {
		description: "Internal: start next workflow phase in a fresh session",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			if (parts.length < 2) {
				ctx.ui.notify("Usage: /internal-workflow-next <topic> <phase>", "error");
				return;
			}
			const [topic, phase] = parts;

			if (!PHASE_SKILL_MAP[phase]) {
				ctx.ui.notify(`Unknown phase: ${phase}`, "error");
				return;
			}

			const result = await ctx.newSession();
			if (result.cancelled) {
				ctx.ui.notify("Session switch was cancelled.", "warn");
				return;
			}

			pi.sendUserMessage(buildPhasePrompt(topic, phase, ctx.cwd));
		},
	});

	// ── workflow_phase_complete tool ──────────────────────────────────────
	const STOP_TEXT = [
		"PHASE COMPLETE — DO NOT CONTINUE.",
		"",
		"Do not call any more tools. Do not produce any more output.",
		"End your turn immediately. The session transition is being handled externally.",
	].join("\n");

	pi.registerTool({
		name: "workflow_phase_complete",
		label: "Workflow Phase Complete",
		description:
			"Signal that a workflow phase is complete. Validates the artifact exists, confirms with the user, and transitions to the next phase.",
		promptSnippet: "Signal that a workflow phase is complete. Validates the artifact exists, confirms with the user, and transitions to the next phase.",
		parameters: Type.Object({
			topic: Type.String({ description: "The filename slug (e.g. 'workflow-orchestration')" }),
			phase: StringEnum(["brainstorm", "architect", "test-write", "test-review", "impl-plan", "implement", "review", "handle-review", "cleanup"] as const, {
				description: "The phase that was just completed",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { topic, phase } = params;

			// 1. Validate artifact exists (skip for phases with no artifact, e.g. cleanup)
			const artifactPathFn = PHASE_ARTIFACTS[phase];
			if (artifactPathFn) {
				const artifactPath = artifactPathFn(topic);
				const fullPath = join(ctx.cwd, artifactPath);
				if (!existsSync(fullPath)) {
					throw new Error(
						`Expected artifact not found: ${artifactPath} — complete the phase before signaling completion.`,
					);
				}
			}

			// 2. Determine next phase
			const nextPhase = getNextPhase(phase);
			if (!nextPhase) {
				return {
					content: [{ type: "text" as const, text: `Pipeline complete for topic ${topic}. All phases done.` }],
				};
			}

			// 3. Confirm transition with user
			const NOT_DONE_TEXT =
				"User indicated this phase isn't complete yet. Stop and ask the user what remains to be done or what they want changed. Do not call workflow_phase_complete again until the user confirms the phase is ready.";

			const appendAnnotation = (text: string, annotation?: string): string =>
				annotation ? `${text} User's note: ${annotation}` : text;

			if (FLEXIBLE_TRANSITIONS.has(phase)) {
				const result = await showNumberedSelect(
					ctx,
					`${phase} done for ${topic}. Move on to ${nextPhase}?`,
					[
						{ label: "Yes, in a new context" },
						{ label: "Yes, in this context" },
						{ label: "No, not done yet" },
					],
				);

				if (result === undefined || result.label === "No, not done yet") {
					return {
						content: [
							{ type: "text" as const, text: appendAnnotation(NOT_DONE_TEXT, result?.annotation) },
						],
					};
				} else if (result.label === "Yes, in this context") {
					const nextSkill = PHASE_SKILL_MAP[nextPhase];
					const lines = [
						`Phase "${phase}" is complete for topic "${topic}". The user indicated you should continue with the **${nextSkill}** skill.`,
						``,
						`Load and follow the \`${nextSkill}\` skill for the topic \`${topic}\`.`,
						``,
						`When the skill's work is done, call \`workflow_phase_complete\` with topic \`${topic}\` and phase \`${nextPhase}\`.`,
					];
					return {
						content: [{ type: "text" as const, text: appendAnnotation(lines.join("\n"), result.annotation) }],
					};
				} else {
					pendingTransition = { topic, phase: nextPhase };
					return { content: [{ type: "text" as const, text: appendAnnotation(STOP_TEXT, result.annotation) }] };
				}
			} else if (phase === "handle-review") {
				const result = await showNumberedSelect(
					ctx,
					`${phase} done for ${topic}. Move on to ${nextPhase}?`,
					[
						{ label: `Yes, start ${nextPhase}` },
						{ label: "Extra review pass" },
						{ label: "No, not done yet" },
					],
				);

				if (result === undefined || result.label === "No, not done yet") {
					return {
						content: [
							{ type: "text" as const, text: appendAnnotation(NOT_DONE_TEXT, result?.annotation) },
						],
					};
				} else if (result.label === "Extra review pass") {
					const reviewPath = join(ctx.cwd, `docs/reviews/${topic}.md`);
					if (existsSync(reviewPath)) {
						unlinkSync(reviewPath);
					}
					pendingTransition = { topic, phase: "review" };
					return { content: [{ type: "text" as const, text: appendAnnotation(STOP_TEXT, result.annotation) }] };
				}

				pendingTransition = { topic, phase: nextPhase };
				return { content: [{ type: "text" as const, text: appendAnnotation(STOP_TEXT, result.annotation) }] };
			} else {
				const result = await showNumberedSelect(
					ctx,
					`${phase} done for ${topic}. Move on to ${nextPhase}?`,
					[
						{ label: `Yes, start ${nextPhase}` },
						{ label: "No, not done yet" },
					],
				);

				if (result === undefined || result.label === "No, not done yet") {
					return {
						content: [
							{ type: "text" as const, text: appendAnnotation(NOT_DONE_TEXT, result?.annotation) },
						],
					};
				}

				pendingTransition = { topic, phase: nextPhase };
				return { content: [{ type: "text" as const, text: appendAnnotation(STOP_TEXT, result.annotation) }] };
			}
		},
	});
}
