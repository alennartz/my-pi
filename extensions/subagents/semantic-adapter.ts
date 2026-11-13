import type { AgentPath } from './agent-path.js';
import type {
  SubagentAwaitStatus,
  SubagentDeltaData,
  SubagentEndData,
  SubagentFiniteData,
  SubagentStartData,
} from '@pimote/sdk/subagents';

export type SemanticOperationKind =
  | 'send'
  | 'respond'
  | 'await'
  | 'delegation'
  | 'completion'
  | 'interrupt'
  | 'teardown'
  | 'resurrect';

export type SemanticPlacement = Readonly<{
  toolCallId: string;
  contentIndex: number;
  entryId?: string;
}>;

export type PiToolCallDelta = Readonly<{
  toolCallId: string;
  contentIndex: number;
  toolName: string;
  path: AgentPath;
  phase: 'start' | 'delta' | 'end';
  delta: string;
}>;

export type PiToolExecution = Readonly<{
  toolCallId: string;
  contentIndex: number;
  toolName: string;
  path: AgentPath;
  result: unknown;
  isError?: boolean;
}>;

export type SemanticStartData = SubagentStartData;
export type SemanticDeltaData = SubagentDeltaData;
export type SemanticEndData = SubagentEndData;

export type SemanticAdapterEvent =
  | Readonly<{
      type: 'start';
      operationId: string;
      kind: SemanticOperationKind;
      path: AgentPath;
      placement: SemanticPlacement;
      data: SemanticStartData;
    }>
  | Readonly<{
      type: 'delta';
      operationId: string;
      kind: 'send' | 'respond' | 'await';
      path: AgentPath;
      placement: SemanticPlacement;
      data: SemanticDeltaData;
    }>
  | Readonly<{
      type: 'end';
      operationId: string;
      kind: SemanticOperationKind;
      path: AgentPath;
      placement: SemanticPlacement;
      state: 'complete' | 'error' | 'aborted';
      data: SemanticEndData;
    }>
  | Readonly<{
      type: 'snapshot';
      operationId: string;
      kind: 'delegation' | 'completion' | 'interrupt' | 'teardown' | 'resurrect';
      path: AgentPath;
      placement: SemanticPlacement;
      state: 'complete' | 'error' | 'aborted';
      data: SubagentFiniteData;
    }>
  | Readonly<{
      type: 'protocol_error';
      operationId: string;
      kind: SemanticOperationKind;
      path: AgentPath;
      placement: SemanticPlacement;
      message: string;
    }>;

export interface SubagentSemanticAdapter {
  acceptToolCallDelta(event: PiToolCallDelta): readonly SemanticAdapterEvent[];
  acceptToolExecution(event: PiToolExecution): readonly SemanticAdapterEvent[];
  acceptResponseProgress(toolCallId: string, delta: string): readonly SemanticAdapterEvent[];
  acceptAwaitProgress(toolCallId: string, statuses: readonly SubagentAwaitStatus[]): readonly SemanticAdapterEvent[];
  completeToolCall(toolCallId: string): readonly SemanticAdapterEvent[];
}

export interface SubagentSemanticAdapterOptions {
  readonly operationId?: (input: { toolCallId: string; kind: SemanticOperationKind }) => string;
}

type OperationState = {
  readonly operationId: string;
  readonly kind: SemanticOperationKind;
  readonly path: AgentPath;
  readonly placement: SemanticPlacement;
  readonly toolName: string;
  started: boolean;
  rawArguments: string;
  request: string;
  response: string;
  body: string;
  requested: readonly AgentPath[];
  statuses: readonly SubagentAwaitStatus[];
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function copyPath(path: AgentPath): AgentPath {
  return Object.freeze([...path]);
}

function placement(event: Pick<PiToolCallDelta, 'toolCallId' | 'contentIndex'>): SemanticPlacement {
  return Object.freeze({ toolCallId: event.toolCallId, contentIndex: event.contentIndex });
}

function pathFrom(value: unknown): AgentPath {
  if (Array.isArray(value)) {
    return copyPath(value.filter((part): part is string => typeof part === 'string' && part.length > 0));
  }
  if (typeof value !== 'string' || value.length === 0) return Object.freeze([]);
  return copyPath(value.split('/').filter(Boolean));
}

function parseJsonObject(raw: string): UnknownRecord | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Extract a JSON string value even while its closing quote is still streaming. */
function partialString(raw: string, key: string): string | undefined {
  const complete = parseJsonObject(raw);
  if (complete && typeof complete[key] === 'string') return complete[key] as string;
  const marker = new RegExp(`"${key}"\\s*:\\s*"`);
  const match = marker.exec(raw);
  if (!match) return undefined;
  let value = '';
  let escaped = false;
  for (let index = match.index + match[0].length; index < raw.length; index += 1) {
    const character = raw[index];
    if (escaped) {
      value += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      value += character;
      escaped = true;
      continue;
    }
    if (character === '"') break;
    value += character;
  }
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\\\/g, '\\');
  }
}

function partialAgents(raw: string): readonly AgentPath[] {
  const complete = parseJsonObject(raw);
  if (complete && Array.isArray(complete.agents)) return Object.freeze(complete.agents.map(pathFrom));
  const match = /"agents"\s*:\s*\[([^\]]*)/.exec(raw);
  if (!match) return Object.freeze([]);
  const values = [...match[1].matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)];
  return Object.freeze(values.map((value) => pathFrom(value[1])));
}

function operationKind(toolName: string): SemanticOperationKind | undefined {
  if (toolName === 'send' || toolName === 'respond' || toolName === 'await_agents') return toolName === 'await_agents' ? 'await' : toolName;
  if (toolName === 'subagent' || toolName === 'fork') return 'delegation';
  if (toolName === 'completion') return 'completion';
  if (toolName === 'interrupt') return 'interrupt';
  if (toolName === 'teardown') return 'teardown';
  if (toolName === 'resurrect') return 'resurrect';
  return undefined;
}

function stateForResult(isError: boolean | undefined, result: unknown): 'complete' | 'error' | 'aborted' {
  if (isError) return 'error';
  if (isRecord(result)) {
    const state = result.state;
    if (state === 'aborted' || state === 'error' || state === 'complete') return state;
    if (result.aborted === true) return 'aborted';
    if (result.isError === true || result.error !== undefined) return 'error';
  }
  return 'complete';
}

function cleanRouterMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanRouterMetadata);
  if (!isRecord(value)) return value;
  const output: UnknownRecord = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'correlationId' || key === 'correlation_id') continue;
    output[key] = cleanRouterMetadata(child);
  }
  return output;
}

function resultRecord(result: unknown): UnknownRecord {
  if (isRecord(result)) {
    const structured = isRecord(result.structuredContent) ? result.structuredContent : undefined;
    if (structured) return structured;
    const details = isRecord(result.details) ? result.details : undefined;
    if (details) return details;
    return result;
  }
  return {};
}

function finiteData(kind: Extract<SemanticOperationKind, 'delegation' | 'completion' | 'interrupt' | 'teardown' | 'resurrect'>, result: unknown, path: AgentPath): SubagentFiniteData {
  const source = cleanRouterMetadata(resultRecord(result)) as UnknownRecord;
  if (kind === 'delegation') {
    const entries = Array.isArray(source.children)
      ? source.children
      : Array.isArray(source.agents) ? source.agents : [];
    const children = entries.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const childPath = pathFrom(entry.path ?? entry.id);
      const task = typeof entry.task === 'string' ? entry.task : '';
      return [{ path: childPath, task, ...(typeof entry.persona === 'string' ? { persona: entry.persona } : {}) }];
    });
    return { operation: 'delegation', children } as SubagentFiniteData;
  }
  if (kind === 'completion') {
    return { operation: 'completion', result: source } as SubagentFiniteData;
  }
  if (kind === 'interrupt') {
    const target = (value: unknown): UnknownRecord => {
      if (isRecord(value)) return { ...value, path: pathFrom(value.path ?? value.id) };
      return { path: pathFrom(value) };
    };
    return {
      operation: 'interrupt',
      result: {
        interrupted: Array.isArray(source.interrupted) ? source.interrupted.map(target) : [],
        pending: Array.isArray(source.pending) ? source.pending.map(target) : [],
        failed: Array.isArray(source.failed) ? source.failed.map(target) : [],
      },
    } as SubagentFiniteData;
  }
  if (kind === 'resurrect') {
    const agents = Array.isArray(source.affectedAgents)
      ? source.affectedAgents
      : Array.isArray(source.agents) ? source.agents : [];
    return {
      operation: 'resurrect',
      result: {
        affectedAgents: agents.filter(isRecord).map((agent) => ({
          path: pathFrom(agent.path ?? agent.id),
          sessionId: typeof agent.sessionId === 'string' ? agent.sessionId : '',
          incarnation: typeof agent.incarnation === 'string' ? agent.incarnation : '',
          state: agent.state === 'running' ? 'running' : 'idle',
          usage: isRecord(agent.usage) ? agent.usage : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
          ...(typeof agent.output === 'string' ? { output: agent.output } : {}),
          ...(typeof agent.error === 'string' ? { error: agent.error } : {}),
        })),
      },
    } as SubagentFiniteData;
  }
  const status = source.status === 'already_removed' || source.status === 'not_found' ? source.status : 'removed';
  const affectedAgents = Array.isArray(source.affectedAgents) ? source.affectedAgents : [];
  return {
    operation: 'teardown',
    result: { status, affectedAgents },
  } as SubagentFiniteData;
}

function changedSuffix(previous: string, next: string, fallback: string): string {
  if (next.startsWith(previous)) return next.slice(previous.length);
  return fallback;
}

/**
 * Adapt Pi's cumulative tool-call stream into typed subagent presentation events.
 * JSON remains an implementation detail of this adapter. Consumers receive only
 * complete operation fields and body deltas.
 */
export function createSubagentSemanticAdapter(options: SubagentSemanticAdapterOptions = {}): SubagentSemanticAdapter {
  const operations = new Map<string, OperationState>();

  function ensureOperation(event: PiToolCallDelta): OperationState | undefined {
    const kind = operationKind(event.toolName);
    if (!kind) return undefined;
    const existing = operations.get(event.toolCallId);
    if (existing) return existing;
    const state: OperationState = {
      operationId: options.operationId?.({ toolCallId: event.toolCallId, kind }) ?? event.toolCallId,
      kind,
      path: copyPath(event.path),
      placement: placement(event),
      toolName: event.toolName,
      started: false,
      rawArguments: '',
      request: '',
      response: '',
      body: '',
      requested: Object.freeze([]),
      statuses: Object.freeze([]),
    };
    operations.set(event.toolCallId, state);
    return state;
  }

  function updateArguments(state: OperationState, delta: string): void {
    state.rawArguments += delta;
    if (state.kind === 'send') {
      state.request = partialString(state.rawArguments, 'message') ?? state.request;
      const source = parseJsonObject(state.rawArguments);
      if (source) state.request = typeof source.message === 'string' ? source.message : state.request;
      return;
    }
    if (state.kind === 'respond') {
      state.body = partialString(state.rawArguments, 'message') ?? state.body;
      const source = parseJsonObject(state.rawArguments);
      if (source) state.body = typeof source.message === 'string' ? source.message : state.body;
      return;
    }
    if (state.kind === 'await') {
      state.requested = partialAgents(state.rawArguments);
    }
  }

  function startData(state: OperationState): SemanticStartData {
    if (state.kind === 'send') {
      const source = parseJsonObject(state.rawArguments);
      return {
        operation: 'send',
        to: pathFrom(source?.to ?? partialString(state.rawArguments, 'to')),
        request: state.request,
        response: state.response,
        phase: 'sending',
      };
    }
    if (state.kind === 'respond') return { operation: 'respond', body: state.body };
    return { operation: 'await', requested: state.requested, statuses: state.statuses };
  }

  function base(state: OperationState) {
    return {
      operationId: state.operationId,
      kind: state.kind,
      path: state.path,
      placement: state.placement,
    } as const;
  }

  function acceptToolCallDelta(event: PiToolCallDelta): readonly SemanticAdapterEvent[] {
    const state = ensureOperation(event);
    if (!state) return [];
    const wasStarted = state.started;
    const previousRequest = state.request;
    const previousBody = state.body;
    updateArguments(state, event.delta);
    if (event.phase === 'start' || !wasStarted) {
      state.started = true;
      return [{ type: 'start', ...base(state), data: startData(state) }];
    }
    if (event.phase === 'end') return [];
    if (state.kind === 'send') {
      const delta = changedSuffix(previousRequest, state.request, '');
      return delta ? [{ type: 'delta', ...base(state), data: { operation: 'send', field: 'request', delta } }] : [];
    }
    if (state.kind === 'respond') {
      const delta = changedSuffix(previousBody, state.body, '');
      return delta ? [{ type: 'delta', ...base(state), data: { operation: 'respond', delta } }] : [];
    }
    return [];
  }

  function endData(state: OperationState, result: unknown): SemanticEndData {
    const source = resultRecord(result);
    if (state.kind === 'send') {
      const target = pathFrom(source.to ?? source.recipient ?? parseJsonObject(state.rawArguments)?.to ?? partialString(state.rawArguments, 'to'));
      const response = typeof source.message === 'string'
        ? source.message
        : typeof source.response === 'string' ? source.response : state.response;
      return {
        operation: 'send',
        to: target,
        request: state.request,
        response,
        ...(typeof source.error === 'string' ? { error: source.error } : {}),
      };
    }
    if (state.kind === 'respond') {
      return {
        operation: 'respond',
        body: typeof source.message === 'string' ? source.message : typeof source.response === 'string' ? source.response : state.body,
        ...(typeof source.error === 'string' ? { error: source.error } : {}),
      };
    }
    const statuses = Array.isArray(source.statuses) ? source.statuses : state.statuses;
    return { operation: 'await', result: { statuses, ...(source.interrupted === true ? { interrupted: true } : {}), ...(typeof source.error === 'string' ? { error: source.error } : {}) } };
  }

  function acceptToolExecution(event: PiToolExecution): readonly SemanticAdapterEvent[] {
    const kind = operationKind(event.toolName);
    if (!kind) return [];
    if (kind === 'delegation' || kind === 'completion' || kind === 'interrupt' || kind === 'teardown' || kind === 'resurrect') {
      const state: OperationState = operations.get(event.toolCallId) ?? {
        operationId: options.operationId?.({ toolCallId: event.toolCallId, kind }) ?? event.toolCallId,
        kind,
        path: copyPath(event.path),
        placement: placement(event),
        toolName: event.toolName,
        started: false,
        rawArguments: '', request: '', response: '', body: '', requested: Object.freeze([]), statuses: Object.freeze([]),
      };
      operations.delete(event.toolCallId);
      return [{ type: 'snapshot', ...base(state), state: stateForResult(event.isError, event.result), data: finiteData(kind, event.result, state.path) }];
    }

    const state = operations.get(event.toolCallId) ?? {
      operationId: options.operationId?.({ toolCallId: event.toolCallId, kind }) ?? event.toolCallId,
      kind,
      path: copyPath(event.path),
      placement: placement(event),
      toolName: event.toolName,
      started: false,
      rawArguments: '', request: '', response: '', body: '', requested: Object.freeze([]), statuses: Object.freeze([]),
    } as OperationState;
    const source = resultRecord(event.result);
    if (kind === 'send') {
      const authoritative = typeof source.message === 'string'
        ? source.message
        : typeof source.response === 'string' ? source.response : undefined;
      if (authoritative !== undefined) state.response = authoritative;
    }
    if (kind === 'respond') {
      const authoritative = typeof source.message === 'string'
        ? source.message
        : typeof source.response === 'string' ? source.response : undefined;
      if (authoritative !== undefined) state.body = authoritative;
    }
    if (kind === 'await' && Array.isArray(source.statuses)) state.statuses = source.statuses as readonly SubagentAwaitStatus[];
    operations.delete(event.toolCallId);
    return [{ type: 'end', ...base(state), state: stateForResult(event.isError, event.result), data: endData(state, event.result) }];
  }

  function acceptResponseProgress(toolCallId: string, delta: string): readonly SemanticAdapterEvent[] {
    const state = operations.get(toolCallId);
    if (!state || state.kind !== 'send') return [];
    state.response += delta;
    return [{ type: 'delta', ...base(state), data: { operation: 'send', field: 'response', delta } }];
  }

  function acceptAwaitProgress(toolCallId: string, statuses: readonly SubagentAwaitStatus[]): readonly SemanticAdapterEvent[] {
    const state = operations.get(toolCallId);
    if (!state || state.kind !== 'await') return [];
    state.statuses = Object.freeze(statuses.map((status) => ({ ...status, path: copyPath(status.path) })));
    return [{ type: 'delta', ...base(state), data: { operation: 'await', statuses: state.statuses } }];
  }

  function completeToolCall(toolCallId: string): readonly SemanticAdapterEvent[] {
    const state = operations.get(toolCallId);
    if (!state) return [];
    operations.delete(toolCallId);
    if (state.kind === 'delegation' || state.kind === 'completion' || state.kind === 'interrupt' || state.kind === 'teardown' || state.kind === 'resurrect') return [];
    return [{ type: 'end', ...base(state), state: 'aborted', data: state.kind === 'send'
      ? { operation: 'send', to: pathFrom(parseJsonObject(state.rawArguments)?.to), request: state.request, response: state.response }
      : state.kind === 'respond'
        ? { operation: 'respond', body: state.body }
        : { operation: 'await', result: { statuses: state.statuses, interrupted: true } } }];
  }

  return { acceptToolCallDelta, acceptToolExecution, acceptResponseProgress, acceptAwaitProgress, completeToolCall };
}
