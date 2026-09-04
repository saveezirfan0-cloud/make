// Core types for Make.com-style blueprint execution.

export interface FilterCondition {
  a?: string;
  b?: string;
  o: string; // operator, e.g. "exist", "text:equal", "text:notcontain"
}

// Conditions are an OR of AND-groups: [[c1 AND c2] OR [c3]]
export type FilterConditions = FilterCondition[][];

export interface FilterSpec {
  name?: string;
  conditions: FilterConditions;
}

export interface IfElseBranch {
  type: 'condition' | 'else';
  label?: string;
  merge?: boolean;
  disabled?: boolean;
  conditions?: FilterConditions;
  flow: BlueprintModule[];
}

export interface RouterRoute {
  flow: BlueprintModule[];
}

export interface BlueprintModule {
  id: number;
  module: string; // e.g. "http:ActionSendData", "airtable:ActionSearchRecords"
  version?: number;
  parameters?: Record<string, unknown>;
  mapper?: Record<string, unknown> | null;
  filter?: FilterSpec | null;
  metadata?: {
    designer?: { name?: string; x?: number; y?: number };
    [key: string]: unknown;
  };
  routes?: RouterRoute[]; // builtin:BasicRouter
  branches?: IfElseBranch[]; // builtin:BasicIfElse
  filters?: (FilterSpec | null)[]; // builtin:BasicMerge input filters
  onerror?: unknown;
}

export interface Blueprint {
  name?: string;
  flow?: BlueprintModule[];
  subflows?: { flow: BlueprintModule[] }[];
  metadata?: Record<string, unknown>;
}

// A connection maps a Make __IMTCONN__ id to an auth secret.
export interface ConnectionConfig {
  type?: string; // "airtable", "http", ...
  token?: string; // API key / OAuth token
}

export interface RunOptions {
  /** User-defined variables, referenced in blueprints as {{var.NAME}} */
  variables?: Record<string, string>;
  /** Map of __IMTCONN__ id -> connection config */
  connections?: Record<string, ConnectionConfig>;
  /** When true, external HTTP calls are logged but not sent */
  dryRun?: boolean;
  /** Hard cap on module executions (default 5000) */
  maxOps?: number;
  /** Per-request timeout in ms (default 40000) */
  requestTimeoutMs?: number;
}

export type LogStatus = 'ok' | 'error' | 'filtered' | 'skipped' | 'dry-run';

export interface LogEntry {
  seq: number;
  moduleId: number;
  module: string;
  name: string;
  status: LogStatus;
  summary?: string;
  request?: unknown;
  output?: unknown;
  error?: string;
  durationMs?: number;
  bundle?: string; // e.g. "3/12" position within an iterator
}

export interface RunResult {
  ok: boolean;
  ops: number;
  durationMs: number;
  log: LogEntry[];
  error?: string;
}

/** Per-bundle evaluation scope. Outputs are copied on branch, vars are shared per run. */
export interface Scope {
  outputs: Record<string, unknown>;
  vars: Record<string, unknown>;
  variables: Record<string, string>;
  feeders: Record<string, { array: unknown[]; index: number; length: number }>;
}

export function cloneScope(s: Scope): Scope {
  return {
    outputs: { ...s.outputs },
    vars: s.vars, // shared
    variables: s.variables,
    feeders: { ...s.feeders },
  };
}
