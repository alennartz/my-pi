import type {
	PersistedSubagentContent as SdkPersistedSubagentContent,
	SubagentAwaitStatus,
	SubagentDelegatedChild,
	SubagentFinalData,
	SubagentOperationKind,
	SubagentToolParameters,
	SubagentUsage,
} from '@pimote/sdk/subagents';
import type { AgentPath } from './agent-path.js';

type RecordData = Record<string, unknown>;
export type PresentationKind = SubagentOperationKind;
export type PersistedSubagentContent = SdkPersistedSubagentContent;

/** Canonical per-operation final-data variants, named for readable builders. */
type SendFinal = Extract<SubagentFinalData, { operation: 'send' }>;
type RespondFinal = Extract<SubagentFinalData, { operation: 'respond' }>;
type AwaitFinal = Extract<SubagentFinalData, { operation: 'await' }>;
type DelegationFinal = Extract<SubagentFinalData, { operation: 'delegation' }>;
type CompletionFinal = Extract<SubagentFinalData, { operation: 'completion' }>;
type InterruptFinal = Extract<SubagentFinalData, { operation: 'interrupt' }>;
type TeardownFinal = Extract<SubagentFinalData, { operation: 'teardown' }>;
type ResurrectFinal = Extract<SubagentFinalData, { operation: 'resurrect' }>;
type ProtocolErrorFinal = Extract<SubagentFinalData, { operation: 'protocol_error' }>;
type InterruptTarget = InterruptFinal['result']['interrupted'][number];

const AWAIT_STATES = ['running', 'waiting', 'idle', 'errored', 'dead', 'stopped'] as const;
type AwaitState = (typeof AWAIT_STATES)[number];
const RESURRECT_STATES = ['idle', 'running'] as const;
type ResurrectState = (typeof RESURRECT_STATES)[number];

function isAwaitState(value: unknown): value is AwaitState {
	return typeof value === 'string' && (AWAIT_STATES as readonly string[]).includes(value);
}

function isResurrectState(value: unknown): value is ResurrectState {
	return typeof value === 'string' && (RESURRECT_STATES as readonly string[]).includes(value);
}

const privateIdentifierFields: readonly string[] = Object.freeze(['correlationId', 'correlation_id', 'routerId', 'router_id', 'pendingCorrelations', 'pending_correlations']);

export function isPresentationRecord(value: unknown): value is RecordData {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function savedPresentationKind(value: RecordData): unknown {
	const data = value.data;
	if (value.kind !== 'send' || value.source !== 'custom_entry' || !isPresentationRecord(data)
		|| data.operation !== 'send' || 'parameters' in data || !isPresentationRecord(data.result)) {return value.kind;}
	const from = data.result.from;
	return Array.isArray(from) && from.every((part) => typeof part === 'string' && part.length > 0)
		? 'message_received' : value.kind;
}

function argumentRecord(value: unknown): RecordData | undefined {
	if (isPresentationRecord(value)) {return value;}
	if (typeof value !== 'string') {return undefined;}
	try {
		const parsed: unknown = JSON.parse(value);
		return isPresentationRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function cleanPresentationValue(value: unknown): unknown {
	if (Array.isArray(value)) {return value.map(cleanPresentationValue);}
	if (!isPresentationRecord(value)) {return value;}
	return Object.fromEntries(Object.entries(value)
		.filter(([key]) => !privateIdentifierFields.includes(key) && !['toolCallId', 'semantic', 'semanticEvents', 'subagentContent'].includes(key))
		.map(([key, child]) => [key, cleanPresentationValue(child)]));
}

export function presentationPath(owner: AgentPath, value: unknown): AgentPath {
	if (Array.isArray(value)) {return value.filter((part): part is string => typeof part === 'string' && part.length > 0);}
	if (typeof value !== 'string' || value.length === 0) {return [...owner];}
	if (value === 'parent') {return owner.slice(0, -1);}
	const path = value.split('/').filter(Boolean);
	return owner.length > 0 && owner.every((part, index) => part === path[index]) ? path : [...owner, ...path];
}

function privateIdentifiers(value: unknown): readonly string[] {
	if (Array.isArray(value)) {return value.flatMap(privateIdentifiers);}
	if (!isPresentationRecord(value)) {return [];}
	return Object.entries(value).flatMap(([key, child]) => privateIdentifierFields.includes(key)
		? (Array.isArray(child) ? child : [child]).filter((id): id is string => typeof id === 'string' && id.length > 0)
		: privateIdentifiers(child));
}

function redactErrors(value: unknown, identifiers: readonly string[]): unknown {
	if (Array.isArray(value)) {return value.map((child) => redactErrors(child, identifiers));}
	if (!isPresentationRecord(value)) {return value;}
	return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key === 'error' && typeof child === 'string'
		? identifiers.reduce((text, id) => text.replaceAll(id, '[redacted]'), child)
		: redactErrors(child, identifiers)]));
}

/**
 * Decode edge: a tool return is runtime data whose shape is known only at
 * runtime. The operation payload rides in `structuredContent` or `details`;
 * the four accounting fields ride on the return itself and are copied by
 * explicit property name, never by looping over keys.
 */
export function publicToolResult(value: unknown, isError = false, parameters?: unknown): RecordData {
	if (!isPresentationRecord(value)) {return redactErrors(isError ? { isError: true, ...(typeof value === 'string' ? { error: value } : {}) } : {}, privateIdentifiers(argumentRecord(parameters))) as RecordData;}
	const source = isPresentationRecord(value.structuredContent) ? value.structuredContent
		: isPresentationRecord(value.details) ? value.details : value.role === 'toolResult' ? {} : value;
	const result = cleanPresentationValue(source) as RecordData;
	if (result.usage === undefined && value.usage !== undefined) {result.usage = cleanPresentationValue(value.usage);}
	if (result.error === undefined && value.error !== undefined) {result.error = cleanPresentationValue(value.error);}
	if (result.aborted === undefined && value.aborted !== undefined) {result.aborted = cleanPresentationValue(value.aborted);}
	if (result.isError === undefined && value.isError !== undefined) {result.isError = cleanPresentationValue(value.isError);}
	if (Array.isArray(value.content) && source === value) {delete result.content;}
	if (isError || result.isError === true) {
		result.isError = true;
		if (result.error === undefined && Array.isArray(value.content)) {
			const text = value.content.flatMap((part) => isPresentationRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n');
			if (text.length > 0) {result.error = text;}
		}
	}
	return redactErrors(result, [...privateIdentifiers(value), ...privateIdentifiers(argumentRecord(parameters))]) as RecordData;
}

export function normalizeToolParameters(operation: SubagentOperationKind, value: unknown, owner: AgentPath, target?: AgentPath): SubagentToolParameters {
	const source = argumentRecord(value);
	const parameters: RecordData = source !== undefined ? cleanPresentationValue(source) as RecordData : {};
	if (operation === 'send' && (target !== undefined || parameters.to !== undefined)) {
		parameters.to = target !== undefined ? [...target] : presentationPath(owner, parameters.to);
	}
	if (operation === 'await' || operation === 'interrupt') {
		if (Array.isArray(parameters.agents) && parameters.agents.length > 0) {parameters.agents = parameters.agents.map((agent) => presentationPath(owner, agent));}
		else {delete parameters.agents;}
	}
	if (operation === 'teardown' && parameters.agent !== undefined) {parameters.agent = presentationPath(owner, parameters.agent);}
	if (operation === 'delegation' && Array.isArray(parameters.agents)) {
		parameters.agents = parameters.agents.map((agent) => {
			if (!isPresentationRecord(agent)) {return agent;}
			const { agent: legacyPersona, ...fields } = agent;
			return { ...fields, ...(fields.persona === undefined && legacyPersona !== undefined ? { persona: legacyPersona } : {}) };
		});
	}
	return parameters;
}

export function normalizeAwaitStatuses(values: readonly unknown[], owner: AgentPath): readonly SubagentAwaitStatus[] {
	return values.flatMap((value) => {
		if (!isPresentationRecord(value)) {return [];}
		const { id, path, status, state, output, error, sessionId } = value;
		const canonicalPath = presentationPath(owner, path ?? id);
		if (canonicalPath.length === 0) {return [];}
		const candidate = state ?? status;
		if (!isAwaitState(candidate)) {return [];}
		const decoded: SubagentAwaitStatus = {
			path: canonicalPath,
			state: candidate,
			...(typeof output === 'string' ? { output } : {}),
			...(typeof error === 'string' ? { error } : {}),
			...(typeof sessionId === 'string' ? { sessionId } : {}),
		};
		return [decoded];
	});
}

export function mergeAwaitStatuses(prior: readonly SubagentAwaitStatus[], next: readonly SubagentAwaitStatus[], requested: readonly AgentPath[] = []): readonly SubagentAwaitStatus[] {
	const merged = new Map([...prior, ...next].map((status) => [JSON.stringify(status.path), status]));
	const requestedKeys = requested.map((path) => JSON.stringify(path));
	const keys = [...requestedKeys, ...[...merged.keys()].filter((key) => !requestedKeys.includes(key))];
	return keys.flatMap((key) => {
		const status = merged.get(key);
		return status ? [{ ...status, path: [...status.path] }] : [];
	});
}

// ---------------------------------------------------------------------------
// Canonical builders
//
// Builders take runtime-decoded inputs and construct one literal canonical
// variant. Excess properties on a literal are a compile error, so a variant
// cannot silently grow a field the contract does not declare: redundancy
// like a leaked message-level usage or a duplicate agent array fails `tsc`
// instead of reaching the transcript.
// ---------------------------------------------------------------------------

function finiteNumber(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function decodeUsage(value: unknown): SubagentUsage {
	if (!isPresentationRecord(value)) {return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };}
	const breakdown = value.costBreakdown;
	const costBreakdown = isPresentationRecord(breakdown)
		? {
			input: finiteNumber(breakdown.input),
			output: finiteNumber(breakdown.output),
			cacheRead: finiteNumber(breakdown.cacheRead),
			cacheWrite: finiteNumber(breakdown.cacheWrite),
		}
		: undefined;
	return {
		input: finiteNumber(value.input),
		output: finiteNumber(value.output),
		cacheRead: finiteNumber(value.cacheRead),
		cacheWrite: finiteNumber(value.cacheWrite),
		cost: finiteNumber(value.cost),
		...(costBreakdown !== undefined ? { costBreakdown } : {}),
		turns: finiteNumber(value.turns),
	};
}

function decodeChildAgent(value: unknown, owner: AgentPath): SubagentDelegatedChild {
	if (!isPresentationRecord(value)) {return { path: presentationPath(owner, value), task: '' };}
	const { id, path, task, persona, status } = value;
	return {
		path: presentationPath(owner, path ?? id),
		task: typeof task === 'string' ? task : '',
		...(typeof persona === 'string' && persona.length > 0 ? { persona } : {}),
		...(isAwaitState(status) ? { status } : {}),
	};
}

type DecodedAffectedCore<S extends AwaitState> = Readonly<{
	path: AgentPath;
	sessionId: string;
	incarnation: string;
	state: S;
	usage: SubagentUsage;
	task?: string;
	channels?: readonly string[];
	model?: string;
	usageBaseline?: SubagentUsage;
}>;

type DecodedAffectedAgent<S extends AwaitState> = Readonly<{
	path: AgentPath;
	sessionId: string;
	incarnation: string;
	state: S;
	usage: SubagentUsage;
	usageBaseline?: SubagentUsage;
	output?: string;
	error?: string;
}>;

function decodeAffectedCore<S extends AwaitState>(value: unknown, owner: AgentPath, isState: (candidate: unknown) => candidate is S): DecodedAffectedCore<S> {
	if (!isPresentationRecord(value)) {return { path: presentationPath(owner, value), sessionId: '', incarnation: 'unknown', state: 'idle' as S, usage: decodeUsage(undefined) };}
	const { id, path, state, status, usage, usageBaseline, task, channels, model } = value;
	const candidate = state ?? status;
	return {
		path: presentationPath(owner, path ?? id),
		sessionId: typeof value.sessionId === 'string' ? value.sessionId : '',
		incarnation: typeof value.incarnation === 'string' ? value.incarnation : 'unknown',
		state: isState(candidate) ? candidate : 'idle' as S,
		usage: decodeUsage(usage),
		...(typeof task === 'string' ? { task } : {}),
		...(Array.isArray(channels) ? { channels: channels.filter((channel): channel is string => typeof channel === 'string') } : {}),
		...(typeof model === 'string' ? { model } : {}),
		...(usageBaseline !== undefined ? { usageBaseline: decodeUsage(usageBaseline) } : {}),
	};
}

function decodeAffectedAgent<S extends AwaitState>(value: unknown, owner: AgentPath, isState: (candidate: unknown) => candidate is S): DecodedAffectedAgent<S> {
	const core = decodeAffectedCore(value, owner, isState);
	if (!isPresentationRecord(value)) {return core;}
	const { output, error } = value;
	return {
		...core,
		...(typeof output === 'string' ? { output } : {}),
		...(typeof error === 'string' ? { error } : {}),
	};
}

function decodeInterruptTarget(value: unknown, owner: AgentPath): InterruptTarget {
	if (!isPresentationRecord(value)) {return { path: presentationPath(owner, value) };}
	const { id, path, output, error } = value;
	return {
		path: presentationPath(owner, path ?? id),
		...(typeof output === 'string' ? { output } : {}),
		...(typeof error === 'string' ? { error } : {}),
	};
}

function buildFinal(operation: SubagentOperationKind, source: RecordData, parameters: SubagentToolParameters, owner: AgentPath, toolBacked: boolean, delegation?: readonly SubagentDelegatedChild[], targetPath?: AgentPath): SubagentFinalData {
	if (operation === 'completion') {
		const { state, output, error, usage } = source;
		const result: CompletionFinal['result'] = {
			state: state === 'errored' || state === 'dead' || state === 'stopped' ? state : 'idle',
			...(typeof output === 'string' ? { output } : {}),
			...(typeof error === 'string' ? { error } : {}),
			...(usage !== undefined ? { usage: decodeUsage(usage) } : {}),
		};
		return { operation: 'completion', result };
	}
	if (operation === 'delegation') {
		const entries = Array.isArray(source.children) ? source.children : Array.isArray(source.agents) ? source.agents : [];
		const normalized = entries.map((child) => decodeChildAgent(child, owner));
		const children = delegation !== undefined ? delegation.map((child) => {
			const prior = normalized.find((entry) => JSON.stringify(entry.path) === JSON.stringify(child.path));
			return { ...(prior ?? {}), ...child, path: [...child.path] };
		}) : normalized;
		const result: DelegationFinal['result'] = { children, ...(typeof source.error === 'string' ? { error: source.error } : {}) };
		return { operation: 'delegation', parameters, result };
	}
	if (operation === 'interrupt') {
		const result: InterruptFinal['result'] = {
			interrupted: (Array.isArray(source.interrupted) ? source.interrupted : []).map((entry) => decodeInterruptTarget(entry, owner)),
			pending: (Array.isArray(source.pending) ? source.pending : []).map((entry) => decodeInterruptTarget(entry, owner)),
			failed: (Array.isArray(source.failed) ? source.failed : []).map((entry) => decodeInterruptTarget(entry, owner)),
			...(typeof source.error === 'string' ? { error: source.error } : {}),
		};
		return { operation: 'interrupt', parameters, result };
	}
	if (operation === 'teardown') {
		const affectedRaw = Array.isArray(source.affectedAgents) ? source.affectedAgents : Array.isArray(source.agents) ? source.agents : [];
		const result: TeardownFinal['result'] = {
			status: source.status === 'already_removed' || source.status === 'not_found' ? source.status : 'removed',
			affectedAgents: affectedRaw.map((agent) => decodeAffectedCore(agent, owner, isAwaitState)),
			...(typeof source.error === 'string' ? { error: source.error } : {}),
		};
		return { operation: 'teardown', parameters, result };
	}
	if (operation === 'resurrect') {
		const affectedRaw = Array.isArray(source.affectedAgents) ? source.affectedAgents : Array.isArray(source.agents) ? source.agents : [];
		const result: ResurrectFinal['result'] = {
			affectedAgents: affectedRaw.map((agent) => decodeAffectedAgent(agent, owner, isResurrectState)),
			...(typeof source.error === 'string' ? { error: source.error } : {}),
		};
		return { operation: 'resurrect', parameters, result };
	}
	if (operation === 'protocol_error') {
		const result: ProtocolErrorFinal['result'] = { error: typeof source.error === 'string' ? source.error : '' };
		return { operation: 'protocol_error', result };
	}
	if (operation === 'await') {
		const statusesRaw = Array.isArray(source.statuses) ? source.statuses : Array.isArray(source.agents) ? source.agents : [];
		const result: AwaitFinal['result'] = {
			statuses: normalizeAwaitStatuses(statusesRaw, owner),
			...(source.interrupted === true ? { interrupted: true } : {}),
			...(typeof source.error === 'string' ? { error: source.error } : {}),
		};
		return { operation: 'await', parameters, result };
	}
	if (operation === 'respond') {
		if (toolBacked) {return { operation: 'respond', parameters, result: { ...source } };}
		const { body, ...rest } = source;
		const result: RespondFinal['result'] = {
			...rest,
			...(body !== undefined ? { message: body } : {}),
		};
		return { operation: 'respond', result };
	}
	// send
	const { recipient, to, from, message, ...rest } = source;
	const toDefined = to !== undefined || recipient !== undefined;
	const responsePreferred = toolBacked && source.response === undefined;
	const result: SendFinal['result'] = {
		...rest,
		...(toDefined ? { to: presentationPath(targetPath ?? owner, to ?? recipient) } : {}),
		...(from !== undefined ? { from: presentationPath(owner, from) } : {}),
		...(message !== undefined && responsePreferred ? { response: message } : {}),
		...(message !== undefined && !responsePreferred ? { message } : {}),
	};
	return { operation: 'send', ...(toolBacked ? { parameters } : {}), result };
}

type FinalInput = Readonly<{
	operation: SubagentOperationKind;
	path: AgentPath;
	parameters?: unknown;
	result: unknown;
	toolBacked: boolean;
	targetPath?: AgentPath;
	delegation?: readonly SubagentDelegatedChild[];
}>;

export function normalizeFinalData(input: FinalInput): SubagentFinalData {
	const source = publicToolResult(input.result, false, input.parameters);
	const parameters = normalizeToolParameters(input.operation, input.parameters, input.path, input.targetPath);
	return buildFinal(input.operation, source, parameters, input.path, input.toolBacked, input.delegation, input.targetPath);
}

type DecodedSaved = {
	operation: SubagentOperationKind;
	source: RecordData;
	parameters: SubagentToolParameters;
	targetPath?: AgentPath;
};

function normalizeSavedData(
	data: RecordData,
	operation: SubagentOperationKind,
	path: AgentPath,
	toolBacked: boolean,
	argumentsValue?: unknown,
): DecodedSaved {
	const parameters = isPresentationRecord(data.parameters) ? data.parameters : argumentRecord(argumentsValue) ?? {};
	if (operation === 'send') {
		const hasEnvelope = isPresentationRecord(data.result);
		const { operation: _operation, request, parameters: _parameters, ...flat } = data;
		const source: RecordData = hasEnvelope ? data.result as RecordData : { ...flat, ...(!toolBacked && request !== undefined ? { message: request } : {}) };
		const inputs = { ...parameters, ...(toolBacked && typeof request === 'string' ? { message: request } : {}) };
		const targetPath = toolBacked && data.to !== undefined ? presentationPath(path, data.to) : undefined;
		return { operation, source, parameters: normalizeToolParameters(operation, inputs, path, targetPath), targetPath };
	}
	if (operation === 'respond') {
		const { operation: _operation, body, parameters: _parameters, ...flat } = data;
		const source: RecordData = isPresentationRecord(data.result) ? data.result : flat;
		return { operation, source, parameters: normalizeToolParameters(operation, { ...parameters, ...(toolBacked && body !== undefined ? { message: body } : {}) }, path) };
	}
	if (operation === 'await') {
		const fallback = argumentsValue === undefined && data.parameters === undefined && Array.isArray(data.requested) && data.requested.length > 0 ? { agents: data.requested } : parameters;
		const source: RecordData = isPresentationRecord(data.result) ? data.result : { statuses: Array.isArray(data.statuses) ? data.statuses : [] };
		return { operation, source, parameters: normalizeToolParameters(operation, fallback, path) };
	}
	if (operation === 'protocol_error') {
		const source: RecordData = isPresentationRecord(data.result) ? data.result : { error: typeof data.message === 'string' ? data.message : '' };
		return { operation, source, parameters };
	}
	const source: RecordData = isPresentationRecord(data.result) ? data.result : operation === 'delegation' && data.children !== undefined ? { children: data.children } : {};
	return { operation, source, parameters: normalizeToolParameters(operation, parameters, path) };
}

export function normalizeSavedPresentationData(input: Readonly<{
	data: RecordData;
	operation: SubagentOperationKind;
	path: AgentPath;
	toolBacked: boolean;
	arguments?: unknown;
	nativeResult?: unknown;
}>): SubagentFinalData {
	const decoded = normalizeSavedData(input.data, input.operation, input.path, input.toolBacked, input.arguments);
	if (!input.toolBacked || input.nativeResult === undefined) {
		return buildFinal(decoded.operation, decoded.source, decoded.parameters, input.path, input.toolBacked, undefined, decoded.targetPath);
	}
	const nativeSource = publicToolResult(input.nativeResult, false, input.arguments);
	const native = buildFinal(input.operation, nativeSource, decoded.parameters, input.path, true, undefined, decoded.targetPath);
	const saved = buildFinal(decoded.operation, decoded.source, decoded.parameters, input.path, input.toolBacked, undefined, decoded.targetPath);
	return mergeFinalData(native, saved);
}

function mergedError(native: Readonly<{ error?: string }>, saved: Readonly<{ error?: string }>): Readonly<{ error?: string }> {
	const error = native.error ?? saved.error;
	return typeof error === 'string' ? { error } : {};
}

function mergeFinalData(native: SubagentFinalData, saved: SubagentFinalData): SubagentFinalData {
	if (native.operation !== saved.operation) {return saved;}
	if (saved.operation === 'delegation' && native.operation === 'delegation') {
		const savedChildren = saved.result.children;
		const byPath = new Map(native.result.children.map((child) => [JSON.stringify(child.path), child]));
		const children = [
			...savedChildren.map((child) => {
				const prior = byPath.get(JSON.stringify(child.path));
				return prior ? { ...prior, ...child } : child;
			}),
			...native.result.children.filter((child) => !savedChildren.some((entry) => JSON.stringify(entry.path) === JSON.stringify(child.path))),
		];
		const result: DelegationFinal['result'] = { children, ...mergedError(native.result, saved.result) };
		return { operation: 'delegation', parameters: saved.parameters, result };
	}
	if (saved.operation === 'teardown' && native.operation === 'teardown') {
		const savedAffected = saved.result.affectedAgents;
		const byPath = new Map(native.result.affectedAgents.map((agent) => [JSON.stringify(agent.path), agent]));
		const affectedAgents = [
			...savedAffected.map((agent) => {
				const prior = byPath.get(JSON.stringify(agent.path));
				return prior ? { ...prior, ...agent } : agent;
			}),
			...native.result.affectedAgents.filter((agent) => !savedAffected.some((entry) => JSON.stringify(entry.path) === JSON.stringify(agent.path))),
		];
		const result: TeardownFinal['result'] = {
			status: saved.result.status !== undefined ? saved.result.status : native.result.status,
			affectedAgents,
			...mergedError(native.result, saved.result),
		};
		return { operation: 'teardown', parameters: saved.parameters, result };
	}
	if (saved.operation === 'resurrect' && native.operation === 'resurrect') {
		const savedAffected = saved.result.affectedAgents;
		const byPath = new Map(native.result.affectedAgents.map((agent) => [JSON.stringify(agent.path), agent]));
		const affectedAgents = [
			...savedAffected.map((agent) => {
				const prior = byPath.get(JSON.stringify(agent.path));
				return prior ? { ...prior, ...agent } : agent;
			}),
			...native.result.affectedAgents.filter((agent) => !savedAffected.some((entry) => JSON.stringify(entry.path) === JSON.stringify(agent.path))),
		];
		const result: ResurrectFinal['result'] = { affectedAgents, ...mergedError(native.result, saved.result) };
		return { operation: 'resurrect', parameters: saved.parameters, result };
	}
	if (saved.operation === 'await' && native.operation === 'await') {
		const result: AwaitFinal['result'] = {
			statuses: mergeAwaitStatuses(native.result.statuses, saved.result.statuses),
			...(native.result.interrupted === true || saved.result.interrupted === true ? { interrupted: true } : {}),
			...(native.result.error !== undefined ? { error: native.result.error } : {}),
			...(saved.result.error !== undefined ? { error: saved.result.error } : {}),
		};
		return { operation: 'await', parameters: saved.parameters, result };
	}
	if (saved.operation === 'send' && native.operation === 'send') {
		const response = saved.result.response !== undefined ? saved.result.response : native.result.response;
		const result: SendFinal['result'] = { ...native.result, ...saved.result, ...(response !== undefined ? { response } : {}) };
		return { operation: 'send', parameters: saved.parameters, result };
	}
	if (saved.operation === 'respond' && native.operation === 'respond') {
		return { operation: 'respond', parameters: saved.parameters, result: { ...native.result, ...saved.result } };
	}
	if (saved.operation === 'completion' && native.operation === 'completion') {
		return { operation: 'completion', result: { ...native.result, ...saved.result } };
	}
	if (saved.operation === 'protocol_error' && native.operation === 'protocol_error') {
		return { operation: 'protocol_error', result: { ...native.result, ...saved.result } };
	}
	return saved;
}
