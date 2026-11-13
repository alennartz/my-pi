import type {
  SubagentAwaitStatus,
  SubagentDelegatedChild,
  SubagentFinalData,
  SubagentOperationKind,
  SubagentToolParameters,
} from '@pimote/sdk/subagents';
import type { AgentPath } from './agent-path.js';

type RecordData = Record<string, unknown>;
const privateIdentifierFields: readonly string[] = Object.freeze(['correlationId', 'correlation_id', 'routerId', 'router_id', 'pendingCorrelations', 'pending_correlations']);

export function isPresentationRecord(value: unknown): value is RecordData {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function argumentRecord(value: unknown): RecordData | undefined {
  if (isPresentationRecord(value)) return value;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isPresentationRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function cleanPresentationValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanPresentationValue);
  if (!isPresentationRecord(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !privateIdentifierFields.includes(key) && !['toolCallId', 'semantic', 'semanticEvents', 'subagentContent'].includes(key))
    .map(([key, child]) => [key, cleanPresentationValue(child)]));
}

export function presentationPath(owner: AgentPath, value: unknown): AgentPath {
  if (Array.isArray(value)) return [...value.filter((part): part is string => typeof part === 'string' && part.length > 0)];
  if (typeof value !== 'string' || value.length === 0) return [...owner];
  if (value === 'parent') return owner.slice(0, -1);
  const path = value.split('/').filter(Boolean);
  return owner.length > 0 && owner.every((part, index) => part === path[index]) ? path : [...owner, ...path];
}

function privateIdentifiers(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap(privateIdentifiers);
  if (!isPresentationRecord(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => privateIdentifierFields.includes(key)
    ? (Array.isArray(child) ? child : [child]).filter((id): id is string => typeof id === 'string' && id.length > 0)
    : privateIdentifiers(child));
}

function redactErrors(value: unknown, identifiers: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((child) => redactErrors(child, identifiers));
  if (!isPresentationRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key === 'error' && typeof child === 'string'
    ? identifiers.reduce((text, id) => text.replaceAll(id, '[redacted]'), child)
    : redactErrors(child, identifiers)]));
}

export function publicToolResult(value: unknown, isError = false, parameters?: unknown): RecordData {
  if (!isPresentationRecord(value)) return redactErrors(isError ? { isError: true, ...(typeof value === 'string' ? { error: value } : {}) } : {}, privateIdentifiers(argumentRecord(parameters))) as RecordData;
  const source = isPresentationRecord(value.structuredContent) ? value.structuredContent
    : isPresentationRecord(value.details) ? value.details : value.role === 'toolResult' ? {} : value;
  const result = cleanPresentationValue(source) as RecordData;
  for (const key of ['usage', 'error', 'aborted', 'isError']) {
    if (result[key] === undefined && value[key] !== undefined) result[key] = cleanPresentationValue(value[key]);
  }
  if (Array.isArray(value.content) && source === value) delete result.content;
  if (isError || result.isError === true) {
    result.isError = true;
    if (result.error === undefined && Array.isArray(value.content)) {
      const text = value.content.flatMap((part) => isPresentationRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n');
      if (text.length > 0) result.error = text;
    }
  }
  return redactErrors(result, [...privateIdentifiers(value), ...privateIdentifiers(argumentRecord(parameters))]) as RecordData;
}

export function normalizeToolParameters(operation: SubagentOperationKind, value: unknown, owner: AgentPath, target?: AgentPath): SubagentToolParameters {
  const source = argumentRecord(value);
  const parameters = source !== undefined ? cleanPresentationValue(source) as RecordData : {};
  if (operation === 'send' && (target !== undefined || parameters.to !== undefined)) {
    parameters.to = target !== undefined ? [...target] : presentationPath(owner, parameters.to);
  }
  if (operation === 'await' || operation === 'interrupt') {
    if (Array.isArray(parameters.agents) && parameters.agents.length > 0) parameters.agents = parameters.agents.map((agent) => presentationPath(owner, agent));
    else delete parameters.agents;
  }
  if (operation === 'teardown' && parameters.agent !== undefined) parameters.agent = presentationPath(owner, parameters.agent);
  if (operation === 'delegation' && Array.isArray(parameters.agents)) {
    parameters.agents = parameters.agents.map((agent) => {
      if (!isPresentationRecord(agent)) return agent;
      const { agent: legacyPersona, ...fields } = agent;
      return { ...fields, ...(fields.persona === undefined && legacyPersona !== undefined ? { persona: legacyPersona } : {}) };
    });
  }
  return parameters;
}

function targetResult(value: unknown, owner: AgentPath): RecordData {
  if (!isPresentationRecord(value)) return { path: presentationPath(owner, value) };
  const { id, path, ...fields } = cleanPresentationValue(value) as RecordData;
  return { ...fields, path: presentationPath(owner, path ?? id) };
}

export function normalizeAwaitStatuses(values: readonly unknown[], owner: AgentPath): readonly SubagentAwaitStatus[] {
  return values.flatMap((value) => {
    if (!isPresentationRecord(value)) return [];
    const { id, path, status, state, ...fields } = cleanPresentationValue(value) as RecordData;
    const canonicalPath = presentationPath(owner, path ?? id);
    if (canonicalPath.length === 0) return [];
    const candidate = state ?? status;
    const canonicalState = candidate === 'running' || candidate === 'waiting' || candidate === 'errored' || candidate === 'dead' || candidate === 'stopped' ? candidate : 'idle';
    return [{ ...fields, path: canonicalPath, state: canonicalState } as SubagentAwaitStatus];
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
  const { operation, path } = input;
  const source = publicToolResult(input.result, false, input.parameters);
  const parameters = normalizeToolParameters(operation, input.parameters, path, input.targetPath);
  if (operation === 'completion') return { operation, result: source } as SubagentFinalData;
  if (operation === 'send') {
    const { recipient, to, from, message, ...fields } = source;
    const result = {
      ...fields,
      ...(to !== undefined || recipient !== undefined ? { to: presentationPath(path, to ?? recipient) } : {}),
      ...(from !== undefined ? { from: presentationPath(path, from) } : {}),
      ...(message !== undefined ? { [input.toolBacked && source.response === undefined ? 'response' : 'message']: message } : {}),
    };
    return { operation, ...(input.toolBacked ? { parameters } : {}), result };
  }
  if (operation === 'respond') return { operation, ...(input.toolBacked ? { parameters } : {}), result: source };
  if (operation === 'await') {
    const { agents, statuses, ...fields } = source;
    return { operation, parameters, result: { ...fields, statuses: normalizeAwaitStatuses(Array.isArray(statuses) ? statuses : Array.isArray(agents) ? agents : [], path) } };
  }
  if (operation === 'delegation') {
    const { agents, children: savedChildren, ...fields } = source;
    const entries = Array.isArray(savedChildren) ? savedChildren : Array.isArray(agents) ? agents : [];
    const normalized = entries.map((entry) => targetResult(entry, path));
    const children = input.delegation !== undefined ? input.delegation.map((child) => ({
      ...normalized.find((entry) => JSON.stringify(entry.path) === JSON.stringify(child.path)),
      ...child,
      path: [...child.path],
    })) : normalized.map((child) => ({ ...child, task: typeof child.task === 'string' ? child.task : '' }));
    return { operation, parameters, result: { ...fields, children } } as SubagentFinalData;
  }
  if (operation === 'interrupt') {
    return { operation, parameters, result: {
      ...source,
      interrupted: (Array.isArray(source.interrupted) ? source.interrupted : []).map((entry) => targetResult(entry, path)),
      pending: (Array.isArray(source.pending) ? source.pending : []).map((entry) => targetResult(entry, path)),
      failed: (Array.isArray(source.failed) ? source.failed : []).map((entry) => targetResult(entry, path)),
    } } as SubagentFinalData;
  }
  const { agents, affectedAgents, ...fields } = source;
  const affected = Array.isArray(affectedAgents) ? affectedAgents : operation === 'resurrect' && Array.isArray(agents) ? agents : [];
  return { operation, parameters, result: {
    ...fields,
    ...(operation === 'teardown' ? { status: source.status ?? 'removed' } : {}),
    ...(operation === 'teardown' && Array.isArray(agents) ? { agents: agents.map((agent) => targetResult(agent, path)) } : {}),
    affectedAgents: affected.map((agent) => targetResult(agent, path)),
  } } as SubagentFinalData;
}

function normalizeSavedData(
  data: RecordData,
  operation: SubagentOperationKind,
  path: AgentPath,
  toolBacked: boolean,
  argumentsValue?: unknown,
): SubagentFinalData {
  if (data.operation === 'protocol_error') return { operation: 'protocol_error', result: publicToolResult(isPresentationRecord(data.result) ? data.result : { error: typeof data.message === 'string' ? data.message : '' }, false, argumentsValue) } as SubagentFinalData;
  const parameters = isPresentationRecord(data.parameters) ? data.parameters : argumentRecord(argumentsValue) ?? {};
  if (operation === 'send') {
    const hasEnvelope = isPresentationRecord(data.result);
    const { operation: _operation, request, parameters: _parameters, ...flat } = data;
    const inputs = { ...parameters, ...(toolBacked && typeof request === 'string' ? { message: request } : {}) };
    const result = hasEnvelope ? data.result : { ...flat, ...(!toolBacked && request !== undefined ? { message: request } : {}) };
    return normalizeFinalData({ operation, path, parameters: inputs, result, toolBacked, ...(toolBacked && data.to !== undefined ? { targetPath: presentationPath(path, data.to) } : {}) });
  }
  if (operation === 'respond') {
    const { operation: _operation, body, parameters: _parameters, ...flat } = data;
    return normalizeFinalData({ operation, path, parameters: { ...parameters, ...(toolBacked && body !== undefined ? { message: body } : {}) }, result: isPresentationRecord(data.result) ? data.result : flat, toolBacked });
  }
  if (operation === 'await') {
    const fallback = argumentsValue === undefined && data.parameters === undefined && Array.isArray(data.requested) && data.requested.length > 0 ? { agents: data.requested } : parameters;
    const result = isPresentationRecord(data.result) ? data.result : { statuses: Array.isArray(data.statuses) ? data.statuses : [] };
    return normalizeFinalData({ operation, path, parameters: fallback, result, toolBacked: true });
  }
  return normalizeFinalData({ operation, path, parameters, result: isPresentationRecord(data.result) ? data.result : operation === 'delegation' ? { children: data.children } : {}, toolBacked });
}

function mergeSavedResults(native: RecordData, saved: RecordData): RecordData {
  const result = { ...native, ...saved };
  for (const key of ['children', 'affectedAgents', 'statuses', 'agents']) {
    const nativeEntries = native[key];
    const savedEntries = saved[key];
    if (!Array.isArray(nativeEntries) || !Array.isArray(savedEntries)) continue;
    const nativeByPath = new Map(nativeEntries.filter(isPresentationRecord).map((entry) => [JSON.stringify(entry.path), entry]));
    const savedPaths = new Set(savedEntries.filter(isPresentationRecord).map((entry) => JSON.stringify(entry.path)));
    result[key] = [
      ...savedEntries.map((entry) => isPresentationRecord(entry) ? { ...nativeByPath.get(JSON.stringify(entry.path)), ...entry } : entry),
      ...nativeEntries.filter((entry) => !isPresentationRecord(entry) || !savedPaths.has(JSON.stringify(entry.path))),
    ];
  }
  if (isPresentationRecord(native.metadata) && isPresentationRecord(saved.metadata)) result.metadata = { ...native.metadata, ...saved.metadata };
  return result;
}

export function normalizeSavedPresentationData(input: Readonly<{
  data: RecordData;
  operation: SubagentOperationKind;
  path: AgentPath;
  toolBacked: boolean;
  arguments?: unknown;
  nativeResult?: unknown;
}>): SubagentFinalData {
  const normalized = normalizeSavedData(input.data, input.operation, input.path, input.toolBacked, input.arguments);
  if (!input.toolBacked || input.nativeResult === undefined) return normalized;
  const nativeSource = publicToolResult(input.nativeResult, false, input.arguments);
  const native = normalizeFinalData({ operation: input.operation, path: input.path, parameters: 'parameters' in normalized ? normalized.parameters : input.arguments, result: nativeSource, toolBacked: true });
  const result = mergeSavedResults(native.result as RecordData, normalized.result as RecordData);
  if (input.operation === 'send' && !isPresentationRecord(input.data.result) && nativeSource.response !== undefined) result.response = nativeSource.response;
  return { ...normalized, result } as SubagentFinalData;
}
