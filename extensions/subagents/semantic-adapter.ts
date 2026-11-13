import type { AgentPath } from './agent-path.js';
import type { SubagentUsage } from './provider.js';

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

export type SemanticStartData =
  | Readonly<{ operation: 'send' | 'respond'; body: string }>
  | Readonly<{ operation: 'await'; requested: readonly AgentPath[] }>;

export type SemanticDeltaData =
  | Readonly<{ operation: 'send' | 'respond'; delta: string }>
  | Readonly<{ operation: 'await'; statuses: readonly unknown[] }>;

export type SemanticEndData =
  | Readonly<{ operation: 'send' | 'respond' | 'completion'; result: Readonly<{ state: 'idle' | 'errored' | 'dead' | 'stopped'; output?: string; error?: string; usage?: SubagentUsage }> }>
  | Readonly<{ operation: 'await'; result: Readonly<{ statuses: readonly unknown[]; interrupted?: boolean; error?: string }> }>
  | Readonly<{ operation: 'teardown'; result: unknown }>
  | Readonly<{ operation: 'interrupt'; result: unknown }>
  | Readonly<{ operation: 'resurrect'; result: unknown }>
  | Readonly<{ operation: 'delegation'; children: readonly unknown[] }>;

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
  completeToolCall(toolCallId: string): readonly SemanticAdapterEvent[];
}

export interface SubagentSemanticAdapterOptions {
  readonly operationId?: (input: { toolCallId: string; kind: SemanticOperationKind }) => string;
}

/** Interface-only adapter factory. Pi stream interpretation belongs to implementation. */
export function createSubagentSemanticAdapter(_options: SubagentSemanticAdapterOptions = {}): SubagentSemanticAdapter {
  throw new Error('not implemented');
}
