import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { getArtifactInventory } from "./phases.ts";

// =============================================================================
// Constants
// =============================================================================

const PHASE_SKILL_MAP: Record<string, string> = {
	brainstorm: "brainstorming",
	architect: "architecting",
	plan: "planning",
	implement: "implementing",
	review: "code-review",
	"handle-review": "handle-review",
	cleanup: "cleanup",
};

const PHASE_ORDER = ["brainstorm", "architect", "plan", "implement", "review", "handle-review", "cleanup"];

/** Phases where the user can choose to continue in the same context or start fresh */
const FLEXIBLE_TRANSITIONS = new Set(["brainstorm", "architect", "review"]);

/** Maps each phase to the artifact path pattern it produces/validates */
const PHASE_ARTIFACTS: Record<string, (topic: string) => string> = {
	brainstorm: (topic) => `docs/brainstorms/${topic}.md`,
	architect: (topic) => `docs/plans/${topic}.md`,
	plan: (topic) => `docs/plans/${topic}.md`,
	implement: (topic) => `docs/plans/${topic}.md`,
	review: (topic) => `docs/reviews/${topic}.md`,
	"handle-review": (topic) => `docs/reviews/${topic}.md`,
};

// =============================================================================
// Prompt helpers
// =============================================================================

const promptTemplate = readFileSync(join(__dirname, "prompt.md"), "utf-8");

function buildEntryPrompt(userInput: string, inventory: string): string {
	return promptTemplate
		.replace("${USER_INPUT}", userInput || "(no input — pick up where we left off or ask)")
		.replace("${INVENTORY}", inventory);
}

function buildPhasePrompt(topic: string, phase: string): string {
	const skill = PHASE_SKILL_MAP[phase];
	return [
		`# Workflow: Continue Pipeline`,
		``,
		`**Topic:** \`${topic}\``,
		`**Phase:** \`${phase}\``,
		`**Skill:** \`${skill}\``,
		``,
		`Load and follow the \`${skill}\` skill for the topic \`${topic}\`.`,
		``,
		`When the skill's work is done, call \`workflow_phase_complete\` with topic \`${topic}\` and phase \`${phase}\`.`,
		``,
		`Follow the skill's instructions for what to read. If you're uncertain about intent or context during a phase, you may consult earlier artifacts (brainstorm, plan) before asking the user — but don't read them by default.`,
	].join("\n");
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
			const inventory = getArtifactInventory();
			const prompt = buildEntryPrompt(args, inventory);
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

			pi.sendUserMessage(buildPhasePrompt(topic, phase));
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
		parameters: Type.Object({
			topic: Type.String({ description: "The filename slug (e.g. 'workflow-orchestration')" }),
			phase: StringEnum(["brainstorm", "architect", "plan", "implement", "review", "handle-review", "cleanup"] as const, {
				description: "The phase that was just completed",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { topic, phase } = params;

			// 1. Validate artifact exists (skip for phases with no artifact, e.g. cleanup)
			const artifactPathFn = PHASE_ARTIFACTS[phase];
			if (artifactPathFn) {
				const artifactPath = artifactPathFn(topic);
				const fullPath = join(process.cwd(), artifactPath);
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
			if (FLEXIBLE_TRANSITIONS.has(phase)) {
				const choice = await ctx.ui.select(
					`${phase} done for ${topic}. Move on to ${nextPhase}?`,
					[
						`Yes, in a new context`,
						`Yes, in this context`,
						`No, not done yet`,
					],
				);

				if (choice === undefined || choice === "No, not done yet") {
					return {
						content: [
							{ type: "text" as const, text: "User indicated this phase isn't complete yet. Continue working." },
						],
					};
				} else if (choice === "Yes, in this context") {
					return {
						content: [{ type: "text" as const, text: `Phase complete. Continuing to ${nextPhase}.` }],
					};
				} else {
					pendingTransition = { topic, phase: nextPhase };
					return { content: [{ type: "text" as const, text: STOP_TEXT }] };
				}
			} else {
				const choice = await ctx.ui.select(
					`${phase} done for ${topic}. Move on to ${nextPhase}?`,
					[
						`Yes, start ${nextPhase}`,
						`No, not done yet`,
					],
				);

				if (choice === undefined || choice === "No, not done yet") {
					return {
						content: [
							{ type: "text" as const, text: "User indicated this phase isn't complete yet. Continue working." },
						],
					};
				}

				pendingTransition = { topic, phase: nextPhase };
				return { content: [{ type: "text" as const, text: STOP_TEXT }] };
			}
		},
	});
}
