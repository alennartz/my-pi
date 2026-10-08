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
 * - `session_start` — front-matter binding (model/tools) once per fresh
 *   session instance.
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
import { Box, Text } from "@earendil-works/pi-tui";
import { loadWorkspacePersona } from "./declaration.ts";
import type { PersonaDeclaration } from "./declaration.ts";
import { getSubagentPersona, isSubagentChildSession } from "../subagents/child-session-marker.ts";
import type { PersonaPayload } from "../subagents/child-session-marker.ts";
import { resolveChildToolPolicy } from "../subagents/child-tool-policy.ts";
import {
	TIERS_UNCONFIGURED_MESSAGE,
	loadTierConfig,
	resolveDeclaredModelRef,
	stripThinkingSuffix,
} from "../subagents/model-tiers.ts";

/** Custom message type for takeover notices; rendered for clean TUI display. */
export const PERSONA_NOTICE_TYPE = "persona-notice";

/** The `session_start` reasons at which a session may bind its persona and announce the takeover. */
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
 * reason and whether it started a fresh session instance, keyed by the
 * SessionManager it was recorded for. Never persisted and never holding
 * declarations or notice flags — it just tells the prompt handler whether
 * this run may bind-and-announce.
 */
type SessionStartState = {
	manager: object | undefined;
	reason: SessionReason | undefined;
	fresh: boolean;
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

	const sessionStart: SessionStartState = { manager: undefined, reason: undefined, fresh: true };

	pi.on("session_start", (event, ctx) => {
		recordSessionStart(
			sessionStart,
			ctx.sessionManager,
			event.reason,
			isFreshSessionInstance(event.reason, ctx.sessionManager),
		);
		if (!sessionStart.fresh) return;
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
			freshInstance: recordedFreshInstance(sessionStart, ctx.sessionManager),
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
	freshInstance: boolean;
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
 * stay silent: only fresh session instances announce, and each condition
 * announces at most once per session instance — reconstructed from the
 * transcript.
 */
function planNotice(input: {
	workspace: PersonaDeclaration | undefined;
	spawned: PersonaPayload | undefined;
	freshInstance: boolean;
	transcript: readonly unknown[];
}): PersonaNotice | undefined {
	if (!input.freshInstance) return undefined;
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
 * Whether a `session_start` started a fresh session instance — one that binds
 * and announces. `new` and `fork` always do; `resume` and `reload` never do.
 * `startup` is ambiguous: pi reports it both for a brand-new session file and
 * for a CLI-opened existing one (`--session`/`--resume`/`--fork` boots all
 * create the initial runtime as `startup`; `resume` is only dispatched for
 * in-process switches). A `startup` is a fresh bind only when the session has
 * no prior conversation to slap back over — or is a CLI fork, which records
 * its source as the header's `parentSession` and binds like any other fork.
 */
function isFreshSessionInstance(reason: SessionReason, manager: object): boolean {
	if (!FRESH_BIND_REASONS.has(reason)) return false;
	if (reason !== "startup") return true;
	const header = sessionHeader(manager);
	if (header?.parentSession !== undefined) return true;
	return !hasConversation(transcriptEntries(manager));
}

/** Whether a transcript carries prior user/assistant turns (a lived-in session). */
function hasConversation(entries: readonly unknown[]): boolean {
	return entries.some((entry) => {
		const record = entry as { type?: string; message?: { role?: string } } | null;
		return (
			record?.type === "message" &&
			(record.message?.role === "user" || record.message?.role === "assistant")
		);
	});
}

/** The session header a manager exposes (real pi sessions), or undefined. */
function sessionHeader(manager: object): { parentSession?: unknown } | undefined {
	const m = manager as { getHeader?: () => unknown };
	const header = typeof m.getHeader === "function" ? m.getHeader() : undefined;
	return (header as { parentSession?: unknown } | null | undefined) ?? undefined;
}

/** Record the latest session-start state for the active session manager. */
function recordSessionStart(
	state: SessionStartState,
	manager: object,
	reason: SessionReason,
	fresh: boolean,
): void {
	state.manager = manager;
	state.reason = reason;
	state.fresh = fresh;
}

/**
 * Whether the session instance recorded for this manager is a fresh bind,
 * defaulting to fresh when nothing was recorded (real pi always dispatches
 * `session_start` before the first run, so an unrecorded reason means a fresh
 * session instance, not a resumed one).
 */
function recordedFreshInstance(state: SessionStartState, manager: object): boolean {
	return state.manager === manager ? state.fresh : true;
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
 * allowed) through the shared model-reference resolver (`diagnostic` failure
 * policy). An unavailable or unauthenticated reference leaves the baseline in
 * place and reports with the existing tier diagnostics vocabulary; a model
 * that did not bind never has its thinking level applied.
 */
async function bindDeclaredModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	modelRef: string,
): Promise<void> {
	const tiers = loadTierConfig({
		globalPath: path.join(getAgentDir(), "model-tiers.json"),
		projectPath: path.join(ctx.cwd, ".pi", "model-tiers.json"),
	});
	const resolution = resolveDeclaredModelRef({
		ref: modelRef,
		tiers,
		available: ctx.modelRegistry.getAvailable(),
		failure: "diagnostic",
	});
	if (resolution.kind === "diagnostic") {
		ctx.ui.notify(resolution.diagnostic, "warning");
		return;
	}
	if (resolution.kind === "fallback") {
		// An unconfigured or unavailable tier leaves the baseline in place.
		const diagnostic =
			resolution.warning ??
			(resolution.tiersEmpty
				? TIERS_UNCONFIGURED_MESSAGE
				: `Model tier "${resolution.ref}" is not configured; using the session default model.`);
		ctx.ui.notify(diagnostic, "warning");
		return;
	}
	if (resolution.model === undefined) return;
	const bound = await pi.setModel(resolution.model);
	if (!bound) {
		// `setModel` returns false when the model's provider has no configured
		// authentication. The baseline model stands, and the persona's thinking
		// level must not be clamped onto it.
		ctx.ui.notify(
			`Model "${stripThinkingSuffix(resolution.canonical).model}" is not authenticated; using the session default model.`,
			"warning",
		);
		return;
	}
	if (resolution.thinking) pi.setThinkingLevel(resolution.thinking);
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
