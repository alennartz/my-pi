import type { AgentPath } from './agent-path.js';
import type {
  SubagentAwaitStatus,
  SubagentDeltaData,
  SubagentEndData,
  SubagentFiniteData,
  SubagentFinalData,
  SubagentStartData,
} from '@pimote/sdk/subagents';
import {
  isPresentationRecord,
  mergeAwaitStatuses,
  normalizeAwaitStatuses,
  normalizeFinalData,
  normalizeToolParameters,
  presentationPath,
  publicToolResult,
} from './presentation-data.js';

export type SemanticOperationKind = 'send' | 'respond' | 'await' | 'delegation' | 'completion' | 'interrupt' | 'teardown' | 'resurrect';
export type SemanticPlacement = Readonly<{ toolCallId: string; contentIndex: number; entryId?: string }> | Readonly<{ entryId: string }>;
export type PiToolCallDelta = Readonly<{
  toolCallId: string;
  contentIndex: number;
  toolName: string;
  path: AgentPath;
  targetPath?: AgentPath;
  phase: 'start' | 'delta' | 'end';
  delta: string;
}>;
export type PiToolExecution = Readonly<{
  toolCallId: string;
  contentIndex: number;
  toolName: string;
  path: AgentPath;
  targetPath?: AgentPath;
  parameters?: unknown;
  result: unknown;
  isError?: boolean;
}>;
export type PiToolExecutionStart = Omit<PiToolExecution, 'result' | 'isError' | 'parameters'> & Readonly<{ arguments: unknown }>;
export type SemanticStartData = SubagentStartData;
export type SemanticDeltaData = SubagentDeltaData;
export type SemanticEndData = SubagentEndData;

type SemanticBase = Readonly<{ operationId: string; kind: SemanticOperationKind; path: AgentPath; placement: SemanticPlacement }>;
export type SemanticAdapterEvent =
  | SemanticBase & Readonly<{ type: 'start'; data: SemanticStartData }>
  | Omit<SemanticBase, 'kind'> & Readonly<{ type: 'delta'; kind: 'send' | 'respond' | 'await'; data: SemanticDeltaData }>
  | SemanticBase & Readonly<{ type: 'end'; state: 'complete' | 'error' | 'aborted'; data: SemanticEndData }>
  | SemanticBase & Readonly<{ type: 'snapshot'; state: 'complete' | 'error' | 'aborted'; data: SubagentFinalData }>
  | SemanticBase & Readonly<{ type: 'protocol_error'; message: string }>;

export interface SubagentSemanticAdapter {
  acceptToolCallDelta(event: PiToolCallDelta): readonly SemanticAdapterEvent[];
  acceptToolExecutionStart(event: PiToolExecutionStart): readonly SemanticAdapterEvent[];
  acceptToolExecution(event: PiToolExecution): readonly SemanticAdapterEvent[];
  acceptResponseProgress(toolCallId: string, delta: string): readonly SemanticAdapterEvent[];
  acceptAwaitProgress(toolCallId: string, statuses: readonly SubagentAwaitStatus[]): readonly SemanticAdapterEvent[];
  completeToolCall(toolCallId: string): readonly SemanticAdapterEvent[];
  setSendTarget(toolCallId: string, path: AgentPath): void;
  getArgument(toolCallId: string, key: string): string | undefined;
}

export interface SubagentSemanticAdapterOptions {
  readonly operationId?: (input: { toolCallId: string; kind: SemanticOperationKind }) => string;
  readonly delegation?: (input: { toolCallId: string; path: AgentPath }) => readonly Readonly<{ path: AgentPath; task: string; persona?: string }>[] | undefined;
}

type OperationState = {
  readonly operationId: string;
  readonly kind: SemanticOperationKind;
  readonly path: AgentPath;
  readonly placement: SemanticPlacement;
  started: boolean;
  rawArguments: string;
  parameters: Readonly<Record<string, unknown>>;
  request: string;
  response: string;
  body: string;
  requested: readonly AgentPath[];
  statuses: readonly SubagentAwaitStatus[];
  sendTarget?: AgentPath;
  sendPhase: 'sending' | 'waiting' | 'responding';
};

function finiteKind(kind: SemanticOperationKind): kind is 'delegation' | 'completion' | 'interrupt' | 'teardown' | 'resurrect' {
  return kind === 'delegation' || kind === 'completion' || kind === 'interrupt' || kind === 'teardown' || kind === 'resurrect';
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return isPresentationRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function partialString(raw: string, key: string): string | undefined {
  const complete = parseJsonObject(raw);
  if (complete && typeof complete[key] === 'string') return complete[key] as string;
  const match = new RegExp(`"${key}"\\s*:\\s*"`).exec(raw);
  if (!match) return undefined;
  let value = '';
  let escaped = false;
  for (let index = match.index + match[0].length; index < raw.length; index += 1) {
    const character = raw[index];
    if (escaped) { value += character; escaped = false; continue; }
    if (character === '\\') { value += character; escaped = true; continue; }
    if (character === '"') break;
    value += character;
  }
  try { return JSON.parse(`"${value}"`); }
  catch { return value.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\\\/g, '\\'); }
}

function operationKind(toolName: string): SemanticOperationKind | undefined {
  if (toolName === 'await_agents') return 'await';
  if (toolName === 'subagent' || toolName === 'fork') return 'delegation';
  if (toolName === 'send' || toolName === 'respond' || toolName === 'completion' || toolName === 'interrupt' || toolName === 'teardown' || toolName === 'resurrect') return toolName;
  return undefined;
}

function stateForResult(isError: boolean | undefined, value: unknown): 'complete' | 'error' | 'aborted' {
  const result = publicToolResult(value);
  if (isError || result.isError === true || result.error !== undefined) return 'error';
  if (result.aborted === true || result.state === 'aborted') return 'aborted';
  if (result.state === 'error') return 'error';
  return 'complete';
}

export function createSubagentSemanticAdapter(options: SubagentSemanticAdapterOptions = {}): SubagentSemanticAdapter {
  const operations = new Map<string, OperationState>();

  function ensureOperation(event: Pick<PiToolCallDelta, 'toolCallId' | 'contentIndex' | 'toolName' | 'path' | 'targetPath'>): OperationState | undefined {
    const kind = operationKind(event.toolName);
    if (!kind) return undefined;
    const prior = operations.get(event.toolCallId);
    if (prior) return prior;
    const state: OperationState = {
      operationId: options.operationId?.({ toolCallId: event.toolCallId, kind }) ?? event.toolCallId,
      kind, path: [...event.path], placement: { toolCallId: event.toolCallId, contentIndex: event.contentIndex },
      started: false, rawArguments: '', parameters: {}, request: '', response: '', body: '', requested: [], statuses: [], sendPhase: 'sending',
      ...(event.targetPath !== undefined ? { sendTarget: [...event.targetPath] } : {}),
    };
    operations.set(event.toolCallId, state);
    return state;
  }

  function updateArguments(state: OperationState, delta: string, replace = false): void {
    state.rawArguments = replace ? delta : state.rawArguments + delta;
    const source = parseJsonObject(state.rawArguments);
    if (source) {
      state.parameters = normalizeToolParameters(state.kind, source, state.path, state.sendTarget);
      state.requested = state.kind === 'await' && Array.isArray(state.parameters.agents) ? state.parameters.agents as AgentPath[] : [];
    }
    if (state.kind === 'send') state.request = partialString(state.rawArguments, 'message') ?? state.request;
    if (state.kind === 'respond') state.body = partialString(state.rawArguments, 'message') ?? state.body;
  }

  function parametersFor(state: OperationState): Readonly<Record<string, unknown>> {
    if (state.kind === 'send') {
      const to = state.parameters.to ?? partialString(state.rawArguments, 'to');
      return normalizeToolParameters('send', { ...state.parameters, message: state.request, ...(to !== undefined ? { to } : {}) }, state.path, state.sendTarget);
    }
    if (state.kind === 'respond') return { ...state.parameters, message: state.body };
    return state.parameters;
  }

  function startData(state: OperationState): SemanticStartData {
    const parameters = parametersFor(state);
    if (state.kind === 'send') return { operation: 'send', parameters, result: { response: state.response, phase: state.sendPhase } };
    if (state.kind === 'respond') return { operation: 'respond', parameters, result: {} };
    return { operation: 'await', parameters, result: { statuses: state.statuses } };
  }

  function base(state: OperationState) {
    return { operationId: state.operationId, kind: state.kind, path: state.path, placement: state.placement } as const;
  }

  function startOperation(state: OperationState): readonly SemanticAdapterEvent[] {
    if (state.started || finiteKind(state.kind)) return [];
    state.started = true;
    return [{ type: 'start', ...base(state), data: startData(state) }];
  }

  function acceptToolCallDelta(event: PiToolCallDelta): readonly SemanticAdapterEvent[] {
    const state = ensureOperation(event);
    if (!state) return [];
    if (event.targetPath !== undefined) state.sendTarget = [...event.targetPath];
    const previous = state.kind === 'send' ? state.request : state.body;
    updateArguments(state, event.delta, event.phase === 'end' && event.delta.length > 0);
    if (finiteKind(state.kind)) return [];
    if (state.kind === 'await') return event.phase === 'end' && parseJsonObject(state.rawArguments) !== undefined ? startOperation(state) : [];
    if (!state.started) return startOperation(state);
    if (event.phase === 'end') {
      if (state.kind === 'send' && state.parameters.expectResponse === true && state.sendPhase === 'sending') {
        state.sendPhase = 'waiting';
        return [{ type: 'delta', ...base(state), kind: 'send', data: { operation: 'send', phase: 'waiting' } }];
      }
      return [];
    }
    const next = state.kind === 'send' ? state.request : state.body;
    const delta = next.startsWith(previous) ? next.slice(previous.length) : '';
    if (!delta) return [];
    return state.kind === 'send'
      ? [{ type: 'delta', ...base(state), kind: 'send', data: { operation: 'send', field: 'request', delta } }]
      : [{ type: 'delta', ...base(state), kind: 'respond', data: { operation: 'respond', delta } }];
  }

  function acceptToolExecutionStart(event: PiToolExecutionStart): readonly SemanticAdapterEvent[] {
    if (!isPresentationRecord(event.arguments)) return [];
    const state = ensureOperation(event);
    if (!state) return [];
    if (event.targetPath !== undefined) state.sendTarget = [...event.targetPath];
    updateArguments(state, JSON.stringify(event.arguments), true);
    return startOperation(state);
  }

  function finalData(state: OperationState, value: unknown, isError = false): SubagentEndData {
    const source = publicToolResult(value, isError, parseJsonObject(state.rawArguments));
    if (state.kind === 'await') {
      const statuses = normalizeAwaitStatuses(Array.isArray(source.statuses) ? source.statuses : Array.isArray(source.agents) ? source.agents : [], state.path);
      state.statuses = mergeAwaitStatuses(state.statuses, statuses, state.requested);
      return normalizeFinalData({ operation: 'await', path: state.path, parameters: parametersFor(state), result: { ...source, statuses: state.statuses }, toolBacked: true }) as SubagentEndData;
    }
    const parameters = parametersFor(state);
    const result = state.kind === 'send' && source.response === undefined && source.message === undefined ? { ...source, response: state.response } : source;
    return normalizeFinalData({ operation: state.kind, path: state.path, parameters, result, toolBacked: true, targetPath: state.sendTarget }) as SubagentEndData;
  }

  function acceptToolExecution(event: PiToolExecution): readonly SemanticAdapterEvent[] {
    const state = ensureOperation(event);
    if (!state) return [];
    if (event.targetPath !== undefined) state.sendTarget = [...event.targetPath];
    if (isPresentationRecord(event.parameters)) updateArguments(state, JSON.stringify(event.parameters), true);
    operations.delete(event.toolCallId);
    if (finiteKind(state.kind)) return [{ type: 'snapshot', ...base(state), kind: state.kind, state: stateForResult(event.isError, event.result), data: normalizeFinalData({
      operation: state.kind, path: state.path, parameters: parametersFor(state), result: publicToolResult(event.result, event.isError, parseJsonObject(state.rawArguments)), toolBacked: true,
      delegation: state.kind === 'delegation' ? options.delegation?.({ toolCallId: event.toolCallId, path: state.path }) : undefined,
    }) as SubagentFiniteData }];
    return [{ type: 'end', ...base(state), state: stateForResult(event.isError, event.result), data: finalData(state, event.result, event.isError) }];
  }

  function acceptResponseProgress(toolCallId: string, delta: string): readonly SemanticAdapterEvent[] {
    const state = operations.get(toolCallId);
    if (!state || state.kind !== 'send') return [];
    const events: SemanticAdapterEvent[] = [];
    if (state.sendPhase !== 'responding') {
      state.sendPhase = 'responding';
      events.push({ type: 'delta', ...base(state), kind: 'send', data: { operation: 'send', phase: 'responding' } });
    }
    state.response += delta;
    if (delta) events.push({ type: 'delta', ...base(state), kind: 'send', data: { operation: 'send', field: 'response', delta } });
    return events;
  }

  function acceptAwaitProgress(toolCallId: string, statuses: readonly SubagentAwaitStatus[]): readonly SemanticAdapterEvent[] {
    const state = operations.get(toolCallId);
    if (!state || state.kind !== 'await') return [];
    state.statuses = mergeAwaitStatuses(state.statuses, normalizeAwaitStatuses(statuses, state.path), state.requested);
    return state.started ? [{ type: 'delta', ...base(state), kind: 'await', data: { operation: 'await', statuses: state.statuses } }] : [];
  }

  function completeToolCall(toolCallId: string): readonly SemanticAdapterEvent[] {
    const state = operations.get(toolCallId);
    if (!state) return [];
    operations.delete(toolCallId);
    if (state.kind === 'await' && !state.started) return [];
    if (finiteKind(state.kind)) return [{ type: 'snapshot', ...base(state), kind: state.kind, state: 'aborted', data: normalizeFinalData({
      operation: state.kind, path: state.path, parameters: parametersFor(state), result: {}, toolBacked: true,
      delegation: state.kind === 'delegation' ? options.delegation?.({ toolCallId, path: state.path }) : undefined,
    }) as SubagentFiniteData }];
    return [{ type: 'end', ...base(state), state: 'aborted', data: finalData(state, state.kind === 'await' ? { statuses: state.statuses, interrupted: true } : state.kind === 'send' ? { response: state.response } : {}) }];
  }

  function setSendTarget(toolCallId: string, path: AgentPath): void {
    const state = operations.get(toolCallId);
    if (state?.kind === 'send') state.sendTarget = [...path];
  }

  function getArgument(toolCallId: string, key: string): string | undefined {
    const state = operations.get(toolCallId);
    return state ? partialString(state.rawArguments, key) : undefined;
  }

  return { acceptToolCallDelta, acceptToolExecutionStart, acceptToolExecution, acceptResponseProgress, acceptAwaitProgress, completeToolCall, setSendTarget, getArgument };
}
