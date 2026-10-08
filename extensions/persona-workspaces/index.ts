/**
 * Persona Workspaces Extension
 *
 * Makes a persona workspace (an AGENTS.md with `kind: persona` front matter in
 * the session's cwd) initialize the session as that specialist, and makes
 * specialist definitions replace pi's persona instead of stacking under it.
 *
 * Two handlers:
 * - `before_agent_start` — prompt binding (persona body replaces the preamble
 *   via `systemPromptOptions.customPrompt`), skills filter, takeover notices.
 * - `session_start` — front-matter binding (model/tools) once at bind time.
 *
 * Persona resolution comes from `declaration.ts`; spawn-declared payloads come
 * from Subagents' child-session registry (`../subagents/child-session-marker.ts`)
 * via `ctx.sessionManager`.
 *
 * One active persona per session, all or nothing: a workspace declaration wins
 * wholesale over a spawn-declared payload, and the losing definition's fields
 * never bind. Subagent children get their capability fields at construction
 * (Subagents owns that path), so this extension never re-binds model/tools in
 * a child — prompt binding and notices are its whole child-side surface.
 *
 * Notes for implementers (from the plan): do NOT set `sections.preamble` — pi
 * throws on custom sections named `preamble`; `customPrompt` is the preamble
 * knob. An explicit `--system-prompt` reaches the handler as a pre-populated
 * `customPrompt` and outranks the ambient persona.
 */

import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Box, Text } from "@earendil-works/pi-tui";
import { loadWorkspacePersona } from "./declaration.ts";
import type { PersonaDeclaration } from "./declaration.ts";
import { getSubagentPersona, isSubagentChildSession } from "../subagents/child-session-marker.ts";
import type { PersonaPayload } from "../subagents/child-session-marker.ts";
import { resolveChildToolPolicy } from "../subagents/child-tool-policy.ts";
import {
	isTierName,
	loadTierConfig,
	resolveModelRef,
	stripThinkingSuffix,
} from "../subagents/model-tiers.ts";
import type { ThinkingLevel, TierConfig } from "../subagents/model-tiers.ts";

/** Custom message type for takeover notices; rendered for clean TUI display. */
export const PERSONA_NOTICE_TYPE = "persona-notice";

/** The `session_start` reasons at which a session binds its persona and announces the takeover. */
const FRESH_BIND_REASONS: ReadonlySet<string> = new Set(["startup", "new", "fork"]);

type SessionReason = SessionStartEvent["reason"];

/** A takeover notice's condition: a first binding, or a workspace overriding a spawn-declared persona. */
type NoticeCondition = "boot" | "override";

/**
 * Metadata persisted with the notice (`details` survives into transcript
 * entries but is never sent to the LLM) so once-per-condition suppression can
 * be reconstructed from the transcript instead of a separate notice registry.
 */
type PersonaNoticeDetails = {
	condition: NoticeCondition;
	persona: string;
	sourcePath?: string;
	replaced?: string;
};

type PersonaNotice = {
	condition: NoticeCondition;
	content: string;
	details: PersonaNoticeDetails;
};

/** What one run must do: bind the preamble and optionally announce the takeover. */
type RunPlan = {
	customPrompt: string;
	dropContextPath?: string;
	declaredSkillNames?: string[];
	notice?: PersonaNotice;
};

/**
 * The only lifecycle state this extension keeps: the latest `session_start`
 * reason, keyed by the SessionManager it was recorded for. Never persisted and
 * never holding declarations or notice flags — it just tells the prompt
 * handler whether this run may bind-and-announce.
 */
type SessionStartState = {
	manager: object | undefined;
	reason: SessionReason | undefined;
};

export default function personaWorkspaces(pi: ExtensionAPI) {
	pi.registerMessageRenderer(PERSONA_NOTICE_TYPE, (message, { outputPad }, theme) => {
		const override = (message.details as PersonaNoticeDetails | undefined)?.condition === "override";
		const label = override ? "[persona override]" : "[persona]";
		const prefix = theme.fg(override ? "warning" : "success", label);
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(`${prefix} ${noticeText(message)}`, 0, 0));
		return box;
	});

	const sessionStart: SessionStartState = { manager: undefined, reason: undefined };

	pi.on("session_start", (event, ctx) => {
		recordSessionStart(sessionStart, ctx.sessionManager, event.reason);
		if (!isFreshBind(event.reason)) return;
		// A subagent child's model/tools/skills are construction-set by the
		// spawn path; binding here would slap that state back.
		if (getSubagentPersona(ctx.sessionManager) || isSubagentChildSession(ctx.sessionManager)) return;
		const workspace = loadWorkspacePersona(ctx.cwd);
		if (!workspace) return;
		return bindDeclaredFrontMatter(pi, ctx, workspace);
	});

	pi.on("before_agent_start", (event, ctx) => {
		const plan = planRunBinding({
			workspace: loadWorkspacePersona(ctx.cwd),
			spawned: getSubagentPersona(ctx.sessionManager),
			explicitCustomPrompt: event.systemPromptOptions.customPrompt,
			startReason: recordedStartReason(sessionStart, ctx.sessionManager),
			transcript: transcriptEntries(ctx.sessionManager),
		});
		if (!plan) return undefined;
		applyRunPlan(event.systemPromptOptions, plan);
		if (!plan.notice) return undefined;
		return { message: noticeMessage(plan.notice) };
	});
}

/**
 * Decide what one run must do. Pure: every input is an argument, nothing is
 * cached between runs. Returns undefined when the run stays untouched — no
 * persona at all, or an explicit `--system-prompt` that outranks the ambient
 * persona (nothing binds and nothing announces).
 */
function planRunBinding(input: {
	workspace: PersonaDeclaration | undefined;
	spawned: PersonaPayload | undefined;
	explicitCustomPrompt: string | undefined;
	startReason: SessionReason | undefined;
	transcript: readonly unknown[];
}): RunPlan | undefined {
	// One active persona per session, all or nothing: the workspace declaration
	// wins wholesale over the spawn-declared payload; fields never merge.
	const persona = input.workspace ?? input.spawned;
	if (!persona) return undefined;
	if (input.explicitCustomPrompt) return undefined;
	return {
		customPrompt: persona.body,
		dropContextPath: input.workspace?.sourcePath,
		declaredSkillNames: input.workspace?.skills,
		notice: planNotice(input),
	};
}

/**
 * Compose the takeover notice for this run, or undefined when the run must
 * stay silent: only fresh binds announce, and each condition announces at
 * most once per session instance — reconstructed from the transcript.
 */
function planNotice(input: {
	workspace: PersonaDeclaration | undefined;
	spawned: PersonaPayload | undefined;
	startReason: SessionReason | undefined;
	transcript: readonly unknown[];
}): PersonaNotice | undefined {
	if (!isFreshBind(input.startReason)) return undefined;
	const notice = composeNotice(input.workspace, input.spawned);
	if (!notice || noticeAlreadyAnnounced(input.transcript, notice.condition)) return undefined;
	return notice;
}

/**
 * The notice text and details for a persona binding. A workspace overriding a
 * spawn-declared payload gets one override notice naming both — the single
 * message slot cannot carry a separate boot notice as well. A spawn-declared
 * payload alone has no source file, and none is ever fabricated.
 */
function composeNotice(
	workspace: PersonaDeclaration | undefined,
	spawned: PersonaPayload | undefined,
): PersonaNotice | undefined {
	if (workspace && spawned) {
		return {
			condition: "override",
			content:
				`Persona override: workspace persona "${workspace.name}" (${workspace.sourcePath}) ` +
				`replaces the spawned persona "${spawned.name}" as this session's persona.`,
			details: {
				condition: "override",
				persona: workspace.name,
				sourcePath: workspace.sourcePath,
				replaced: spawned.name,
			},
		};
	}
	if (workspace) {
		return {
			condition: "boot",
			content: `Persona takeover: "${workspace.name}" (${workspace.sourcePath}) is now this session's persona.`,
			details: { condition: "boot", persona: workspace.name, sourcePath: workspace.sourcePath },
		};
	}
	if (spawned) {
		return {
			condition: "boot",
			content: `Persona takeover: spawned persona "${spawned.name}" is now this session's persona.`,
			details: { condition: "boot", persona: spawned.name },
		};
	}
	return undefined;
}

/** Apply the planned binding to this run's prompt options. */
function applyRunPlan(
	options: BeforeAgentStartEvent["systemPromptOptions"],
	plan: RunPlan,
): void {
	options.customPrompt = plan.customPrompt;
	if (plan.dropContextPath !== undefined) {
		// Only the workspace's own declaration file, so pi cannot append it twice.
		options.contextFiles = options.contextFiles.filter((file) => file.path !== plan.dropContextPath);
	}
	if (plan.declaredSkillNames !== undefined) {
		const declared = new Set(plan.declaredSkillNames);
		options.skills = options.skills.filter((skill) => declared.has(skill.name));
	}
}

/** The transcript-visible custom message carrying the takeover notice. */
function noticeMessage(notice: PersonaNotice): BeforeAgentStartEventResult["message"] {
	return {
		customType: PERSONA_NOTICE_TYPE,
		content: notice.content,
		display: true,
		details: notice.details,
	};
}

/**
 * Fresh binds are `startup`, `new`, and `fork`; `resume` and `reload` never
 * rebind or announce (a user's mid-session choice is never slapped back). An
 * unrecorded reason counts as fresh — real pi always dispatches
 * `session_start` before the first run, so an unrecorded reason means a fresh
 * session instance, not a resumed one.
 */
function isFreshBind(reason: SessionReason | undefined): boolean {
	return reason === undefined || FRESH_BIND_REASONS.has(reason);
}

/** Record the latest session-start reason for the active session manager. */
function recordSessionStart(
	state: SessionStartState,
	manager: object,
	reason: SessionReason,
): void {
	state.manager = manager;
	state.reason = reason;
}

/** The recorded reason for this session manager, or undefined when unrecorded. */
function recordedStartReason(
	state: SessionStartState,
	manager: object,
): SessionReason | undefined {
	return state.manager === manager ? state.reason : undefined;
}

/**
 * Whether a persona notice for this condition is already on the transcript.
 * Legacy notice entries without details suppress every condition — what they
 * announced cannot be known, so nothing is re-announced.
 */
function noticeAlreadyAnnounced(
	transcript: readonly unknown[],
	condition: NoticeCondition,
): boolean {
	for (const entry of transcript) {
		const seen = personaNoticeCondition(entry);
		if (seen === undefined) continue;
		if (seen === "unknown" || seen === condition) return true;
	}
	return false;
}

/**
 * The notice condition a transcript entry records, "unknown" for a persona
 * notice whose condition cannot be derived, and undefined for any other entry.
 */
function personaNoticeCondition(entry: unknown): NoticeCondition | "unknown" | undefined {
	const record = entry as {
		type?: string;
		customType?: string;
		content?: unknown;
		details?: { condition?: unknown };
	} | null;
	if (!record || record.type !== "custom_message" || record.customType !== PERSONA_NOTICE_TYPE) {
		return undefined;
	}
	const condition = record.details?.condition;
	if (condition === "boot" || condition === "override") return condition;
	// Plain-message fallback: the content wording identifies the condition.
	const text = typeof record.content === "string" ? record.content : "";
	if (text.startsWith("Persona override")) return "override";
	if (text.startsWith("Persona takeover")) return "boot";
	return "unknown";
}

/**
 * The transcript surface for notice deduplication: the current branch when the
 * session manager exposes one (real pi sessions), else all entries.
 */
function transcriptEntries(sessionManager: object): readonly unknown[] {
	const manager = sessionManager as {
		getBranch?: () => unknown[];
		getEntries?: () => unknown[];
	};
	const entries = typeof manager.getBranch === "function" ? manager.getBranch() : manager.getEntries?.();
	return Array.isArray(entries) ? entries : [];
}

/**
 * Bind the workspace declaration's `model`/`tools` at fresh session bind time.
 * Absent fields bind nothing and pi's baseline stands.
 */
async function bindDeclaredFrontMatter(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	declaration: PersonaDeclaration,
): Promise<void> {
	if (declaration.model) await bindDeclaredModel(pi, ctx, declaration.model);
	if (declaration.tools) {
		// Exactly the child-side normalization, shared semantics included.
		pi.setActiveTools(resolveChildToolPolicy({ kind: "persona", tools: declaration.tools }).allowedTools);
	}
}

/**
 * Bind a declared model reference (tier name or model id, `:<level>` suffix
 * allowed). An unavailable or unconfigured reference leaves the baseline in
 * place and reports with the existing tier diagnostics vocabulary.
 */
async function bindDeclaredModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	modelRef: string,
): Promise<void> {
	const tiers = loadTierConfig({
		globalPath: path.join(getAgentDir(), "model-tiers.json"),
		projectPath: path.join(ctx.cwd, ".pi", "model-tiers.json"),
		projectTrusted: ctx.isProjectTrusted(),
	});
	const binding = resolveDeclaredModel(modelRef, tiers, ctx.modelRegistry.getAvailable());
	if (!binding) return;
	if ("diagnostic" in binding) {
		ctx.ui.notify(binding.diagnostic, "warning");
		return;
	}
	await pi.setModel(binding.model);
	if (binding.thinking) pi.setThinkingLevel(binding.thinking);
}

type ModelBinding = { model: Model<unknown>; thinking?: ThinkingLevel } | { diagnostic: string };

/**
 * Resolve a declared model reference against the tier config and the available
 * models. Pure. Matching is the `/fmodel` pattern: id or provider/id.
 */
function resolveDeclaredModel(
	modelRef: string,
	tiers: TierConfig,
	available: readonly Model<unknown>[],
): ModelBinding | undefined {
	if (isTierName(modelRef) && tiers[modelRef] === undefined) {
		return {
			diagnostic:
				Object.keys(tiers).length === 0
					? "model tiers unconfigured; all tiers use the session default model"
					: `Model tier "${modelRef}" is not configured; using the session default model.`,
		};
	}
	const resolved = resolveModelRef(modelRef, tiers, (ref) => findAvailableModel(available, ref) !== undefined);
	if (resolved.warning) return { diagnostic: resolved.warning };
	if (!resolved.model) return undefined;
	// A `:<level>` suffix binds the thinking level alongside the model.
	const { model, thinking } = stripThinkingSuffix(resolved.model);
	const match = findAvailableModel(available, model);
	if (!match) return { diagnostic: `Unknown model "${model}"` };
	return thinking !== undefined ? { model: match, thinking } : { model: match };
}

/** Find an available model by id or provider/id. */
function findAvailableModel(
	available: readonly Model<unknown>[],
	ref: string,
): Model<unknown> | undefined {
	return available.find(
		(candidate) => candidate?.id === ref || `${candidate?.provider}/${candidate?.id}` === ref,
	);
}

/** The informational text of a custom message (string content, or its text parts). */
function noticeText(message: { content: unknown }): string {
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return message.content
			.filter((part) => (part as { type?: string }).type === "text")
			.map((part) => (part as { text?: string }).text ?? "")
			.join("\n");
	}
	return "";
}
