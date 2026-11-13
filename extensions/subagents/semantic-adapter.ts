import type { AgentPath } from './agent-path.js';
import type { SubagentStartData, SubagentDeltaData, SubagentEndData, SubagentFiniteData, SubagentAwaitStatus } from '@pimote/sdk/subagents';

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

/** Interface-only adapter factory. Pi stream interpretation belongs to implementation. */
export function createSubagentSemanticAdapter(_options: SubagentSemanticAdapterOptions = {}): SubagentSemanticAdapter {
  throw new Error('not implemented');
}
