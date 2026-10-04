/**
 * Pure trigger logic for autoflow autostart: when a new session is armed, and
 * what (if anything) the first user message is rewritten to.
 */

/** Session-start reasons that may arm the trigger (subject to entry count). */
export const ARMABLE_REASONS = ["startup", "new", "reload"] as const;
export type ArmableReason = (typeof ARMABLE_REASONS)[number];

export interface ArmFacts {
	reason: string;
	/** Whether the session already contains exchanged messages. */
	hasPriorMessages: boolean;
	/** True when this session is a subagent child session. */
	isSubagentChild: boolean;
	/** The opt-in flag from autoflow.json. */
	autoStart: boolean;
}

/**
 * Arm the trigger only for a genuinely fresh session: the opt-in is on, this
 * is the root session, and no messages have been exchanged yet. Resumes,
 * forks and subagent children never autostart.
 */
export function shouldArm(facts: ArmFacts): boolean {
	if (!facts.autoStart) return false;
	if (facts.isSubagentChild) return false;
	if (!(ARMABLE_REASONS as readonly string[]).includes(facts.reason)) return false;
	return !facts.hasPriorMessages;
}

export interface PlanInputFacts {
	/** Raw input text as typed. */
	text: string;
	/** Set when the input is queued during streaming rather than opening the session. */
	streamingBehavior?: "steer" | "followUp";
	/** Slash command that invokes autoflow, e.g. `/skill:autoflow`. */
	command: string;
}

export type InputPlan =
	| { armed: boolean; action: { kind: "pass" } }
	| { armed: boolean; action: { kind: "transform"; text: string } };

function pass(armed: boolean): InputPlan {
	return { armed, action: { kind: "pass" } };
}

function firstToken(text: string): string {
	const spaceIndex = text.indexOf(" ");
	return spaceIndex === -1 ? text : text.slice(0, spaceIndex);
}

/** `/skill:autoflow` and `/autoflow` both name the autoflow command. */
function commandName(token: string): string {
	return token.startsWith("/skill:") ? token.slice("/skill:".length) : token.slice(1);
}

/** Whether this input already invokes autoflow (however it is spelled). */
export function isAutoflowInvocation(text: string, command: string): boolean {
	const token = firstToken(text.trim());
	if (!token.startsWith("/")) return false;
	if (commandName(token) === "autoflow") return true;
	return token === firstToken(command.trim());
}

/**
 * Decide what happens to one input while the trigger is armed.
 *
 * Only the user's first plain message is rewritten into an autoflow
 * invocation with the message appended. Slash commands and `!`/`!!` bash
 * commands are not the first message and pass through untouched (the trigger
 * stays armed), except an autoflow invocation, which the user issued
 * themselves and which consumes the trigger. Input queued while a turn is
 * already streaming is not the session's opening message and disarms without
 * a rewrite.
 */
export function planInput(armed: boolean, facts: PlanInputFacts): InputPlan {
	if (!armed) return pass(false);
	if (facts.streamingBehavior !== undefined) return pass(false);
	const trimmed = facts.text.trim();
	if (trimmed === "") return pass(true);
	if (trimmed.startsWith("!")) return pass(true);
	if (trimmed.startsWith("/")) return pass(!isAutoflowInvocation(trimmed, facts.command));
	return {
		armed: false,
		action: { kind: "transform", text: `${facts.command} ${facts.text}` },
	};
}
