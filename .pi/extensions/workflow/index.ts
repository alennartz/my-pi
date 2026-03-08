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
};

const PHASE_ORDER = ["brainstorm", "architect", "plan", "implement", "review", "handle-review"];

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
	// ── /workflow command ──────────────────────────────────────────────────
	pi.registerCommand("workflow", {
		description: "Start or continue the development workflow pipeline",
		handler: async (args, _ctx) => {
			const inventory = getArtifactInventory();
			const prompt = buildEntryPrompt(args, inventory);
			pi.sendUserMessage(prompt);
		},
	});

	// ── workflow_phase_complete tool ──────────────────────────────────────
	pi.registerTool({
		name: "workflow_phase_complete",
		label: "Workflow Phase Complete",
		description:
			"Signal that a workflow phase is complete. Validates the artifact exists, confirms with the user, and transitions to the next phase.",
		parameters: Type.Object({
			topic: Type.String({ description: "The filename slug (e.g. 'workflow-orchestration')" }),
			phase: StringEnum(["brainstorm", "architect", "plan", "implement", "review", "handle-review"] as const, {
				description: "The phase that was just completed",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { topic, phase } = params;

			// 1. Validate artifact exists
			const artifactPathFn = PHASE_ARTIFACTS[phase];
			if (!artifactPathFn) {
				throw new Error(`Unknown phase: ${phase}`);
			}
			const artifactPath = artifactPathFn(topic);
			const fullPath = join(process.cwd(), artifactPath);
			if (!existsSync(fullPath)) {
				throw new Error(
					`Expected artifact not found: ${artifactPath} — complete the phase before signaling completion.`,
				);
			}

			// 2. Determine next phase
			const nextPhase = getNextPhase(phase);
			if (!nextPhase) {
				return {
					content: [{ type: "text" as const, text: `Pipeline complete for topic ${topic}. All phases done.` }],
				};
			}

			// 3. Confirm with user
			const confirmed = await ctx.ui.confirm(
				"Phase complete?",
				`Move on from ${phase} for ${topic}?`,
			);
			if (!confirmed) {
				return {
					content: [
						{ type: "text" as const, text: "User indicated this phase isn't complete yet. Continue working." },
					],
				};
			}

			// 4. Transition
			if (FLEXIBLE_TRANSITIONS.has(phase)) {
				// Flexible: let user choose
				const choice = await ctx.ui.select("Context for next phase:", [
					"Continue in this context",
					"Start fresh context",
				]);

				if (choice === undefined) {
					return {
						content: [{ type: "text" as const, text: "Transition cancelled. Staying in the current phase." }],
					};
				} else if (choice === "Continue in this context") {
					pi.sendUserMessage(buildPhasePrompt(topic, nextPhase), { deliverAs: "followUp" });
					return {
						content: [{ type: "text" as const, text: `Phase complete. Continuing to ${nextPhase}.` }],
					};
				} else {
					pi.sendUserMessage(`/workflow-new-session ${topic} ${nextPhase}`, { deliverAs: "followUp" });
					return {
						content: [
							{ type: "text" as const, text: `Phase complete. Starting fresh context for ${nextPhase}.` },
						],
					};
				}
			} else {
				// Mandatory: always start fresh
				pi.sendUserMessage(`/workflow-new-session ${topic} ${nextPhase}`, { deliverAs: "followUp" });
				return {
					content: [
						{ type: "text" as const, text: `Phase complete. Starting fresh context for ${nextPhase}.` },
					],
				};
			}
		},
	});

	// ── /workflow-new-session internal command ────────────────────────────
	pi.registerCommand("workflow-new-session", {
		description: "Internal: start a fresh session for a workflow phase transition",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			if (parts.length < 2) {
				ctx.ui.notify("Usage: /workflow-new-session <topic> <phase>", "error");
				return;
			}
			const [topic, nextPhase] = parts;

			const result = await ctx.newSession();
			if (result.cancelled) {
				ctx.ui.notify("Session switch was cancelled.", "warn");
				return;
			}

			pi.sendUserMessage(buildPhasePrompt(topic, nextPhase));
		},
	});
}
