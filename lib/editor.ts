// Editor model: addressing flows inside a blueprint, immutable mutations,
// and the module catalog for the "add module" picker.

import type { Blueprint, BlueprintModule } from './engine/types';

export type FlowPath = { id: number; slot: 'route' | 'branch'; idx: number }[];

export function rootFlow(bp: Blueprint): BlueprintModule[] {
  if (bp.subflows?.length) return bp.subflows[0].flow ?? [];
  if (bp.flow) return bp.flow;
  return [];
}

/** Child flows of a module (router routes / if-else branches), or null. */
export function childFlows(mod: BlueprintModule): { slot: 'route' | 'branch'; flows: BlueprintModule[][] } | null {
  if (mod.routes) return { slot: 'route', flows: mod.routes.map((r) => r.flow ?? (r.flow = [])) };
  if (mod.branches) return { slot: 'branch', flows: mod.branches.map((b) => b.flow ?? (b.flow = [])) };
  return null;
}

export function getFlow(bp: Blueprint, path: FlowPath): BlueprintModule[] {
  let flow = rootFlow(bp);
  for (const seg of path) {
    const mod = flow.find((m) => m.id === seg.id);
    if (!mod) return [];
    if (seg.slot === 'route') {
      mod.routes![seg.idx].flow ??= [];
      flow = mod.routes![seg.idx].flow;
    } else {
      mod.branches![seg.idx].flow ??= [];
      flow = mod.branches![seg.idx].flow;
    }
  }
  return flow;
}

export function walkModules(bp: Blueprint, fn: (m: BlueprintModule) => void): void {
  const visit = (mods?: BlueprintModule[]) => {
    for (const m of mods ?? []) {
      fn(m);
      for (const r of m.routes ?? []) visit(r.flow);
      for (const b of m.branches ?? []) visit(b.flow);
    }
  };
  if (bp.subflows) for (const s of bp.subflows) visit(s.flow);
  else visit(bp.flow);
}

export function nextId(bp: Blueprint): number {
  let max = 0;
  walkModules(bp, (m) => {
    if (m.id > max) max = m.id;
  });
  return max + 1;
}

export function findModule(bp: Blueprint, id: number): BlueprintModule | null {
  let found: BlueprintModule | null = null;
  walkModules(bp, (m) => {
    if (m.id === id) found = m;
  });
  return found;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Ensure the blueprint has a root flow container. */
export function normalizeBlueprint(bp: Blueprint): Blueprint {
  if (!bp.subflows?.length && !bp.flow) return { ...bp, subflows: [{ flow: [] }] };
  return bp;
}

export function insertModule(bp: Blueprint, path: FlowPath, index: number, mod: BlueprintModule): Blueprint {
  const next = normalizeBlueprint(clone(bp));
  const flow = getFlow(next, path);
  flow.splice(Math.max(0, Math.min(index, flow.length)), 0, mod);
  return next;
}

export function deleteModule(bp: Blueprint, path: FlowPath, index: number): Blueprint {
  const next = clone(bp);
  const flow = getFlow(next, path);
  flow.splice(index, 1);
  return next;
}

export function updateModule(bp: Blueprint, id: number, updater: (m: BlueprintModule) => void): Blueprint {
  const next = clone(bp);
  walkModules(next, (m) => {
    if (m.id === id) updater(m);
  });
  return next;
}

export function addRouteOrBranch(bp: Blueprint, id: number): Blueprint {
  return updateModule(bp, id, (m) => {
    if (m.routes) m.routes.push({ flow: [] });
    else if (m.branches) {
      // insert before the else branch if present
      const elseIdx = m.branches.findIndex((b) => b.type === 'else');
      const branch = { type: 'condition' as const, label: '', merge: true, disabled: false, conditions: [[]] as never, flow: [] };
      if (elseIdx >= 0) m.branches.splice(elseIdx, 0, branch);
      else m.branches.push(branch);
    }
  });
}

export function removeRouteOrBranch(bp: Blueprint, id: number, idx: number): Blueprint {
  return updateModule(bp, id, (m) => {
    if (m.routes && m.routes.length > 1) m.routes.splice(idx, 1);
    else if (m.branches && m.branches.length > 1) m.branches.splice(idx, 1);
  });
}

// ---------------------------------------------------------------------------
// Visual metadata per app

export interface AppStyle {
  color: string;
  glyph: string;
}

export function moduleStyle(moduleType: string): AppStyle {
  const app = moduleType.split(':')[0];
  const action = moduleType.split(':')[1] ?? '';
  if (app === 'http') return { color: '#0ea5e9', glyph: 'HTTP' };
  if (app === 'airtable') return { color: '#f59e0b', glyph: 'AT' };
  if (app === 'json') return { color: '#14b8a6', glyph: '{ }' };
  if (app === 'placeholder') return { color: '#6b7280', glyph: '·' };
  if (app === 'builtin') {
    if (action.includes('Feeder') || action.includes('Iterator')) return { color: '#8b5cf6', glyph: '⇶' };
    if (action.includes('Router')) return { color: '#8b5cf6', glyph: '⑂' };
    if (action.includes('IfElse')) return { color: '#8b5cf6', glyph: 'IF' };
    if (action.includes('Merge')) return { color: '#8b5cf6', glyph: '⑃' };
    return { color: '#8b5cf6', glyph: 'FN' };
  }
  if (app === 'util') {
    if (action.includes('SetVariable')) return { color: '#22c55e', glyph: 'x=' };
    if (action.includes('GetVariable')) return { color: '#22c55e', glyph: 'x?' };
    if (action.includes('Aggregator')) return { color: '#22c55e', glyph: 'Σ' };
    return { color: '#22c55e', glyph: 'fx' };
  }
  return { color: '#64748b', glyph: app.slice(0, 3).toUpperCase() };
}

export function defaultName(mod: BlueprintModule): string {
  const custom = mod.metadata?.designer?.name;
  if (custom) return custom;
  const entry = CATALOG.find((c) => c.type === mod.module);
  if (entry) return entry.label;
  return mod.module.split(':')[1] ?? mod.module;
}

// ---------------------------------------------------------------------------
// Module catalog (the "add module" picker)

export interface CatalogEntry {
  type: string;
  label: string;
  group: string;
  description: string;
  make: (id: number) => BlueprintModule;
}

export const CATALOG: CatalogEntry[] = [
  {
    type: 'http:ActionSendData',
    label: 'HTTP Request',
    group: 'HTTP',
    description: 'Call any REST API (GET/POST/PUT/PATCH/DELETE)',
    make: (id) => ({
      id,
      module: 'http:ActionSendData',
      version: 3,
      parameters: { handleErrors: true },
      mapper: {
        url: 'https://',
        method: 'get',
        headers: [],
        qs: [],
        bodyType: 'raw',
        contentType: 'application/json',
        data: '',
        parseResponse: true,
        followRedirect: true,
        rejectUnauthorized: true,
        serializeUrl: false,
        shareCookies: false,
        gzip: true,
        useQuerystring: false,
        followAllRedirects: false,
        useMtls: false,
        timeout: '',
        ca: '',
        authUser: '',
        authPass: '',
      },
    }),
  },
  {
    type: 'airtable:ActionSearchRecords',
    label: 'Airtable · Search records',
    group: 'Airtable',
    description: 'Search a table with a formula; outputs one bundle per record',
    make: (id) => ({
      id,
      module: 'airtable:ActionSearchRecords',
      version: 3,
      parameters: { __IMTCONN__: '' as unknown as number },
      mapper: { base: '', table: '', formula: '', maxRecords: '10', useColumnId: false },
    }),
  },
  {
    type: 'airtable:ActionCreateRecord',
    label: 'Airtable · Create record',
    group: 'Airtable',
    description: 'Create a record (field id/name → value)',
    make: (id) => ({
      id,
      module: 'airtable:ActionCreateRecord',
      version: 3,
      parameters: { __IMTCONN__: '' as unknown as number },
      mapper: { base: '', table: '', record: {}, typecast: false, useColumnId: true },
    }),
  },
  {
    type: 'airtable:ActionUpdateRecords',
    label: 'Airtable · Update record',
    group: 'Airtable',
    description: 'Update a record by id',
    make: (id) => ({
      id,
      module: 'airtable:ActionUpdateRecords',
      version: 3,
      parameters: { __IMTCONN__: '' as unknown as number },
      mapper: { id: '', base: '', table: '', record: {}, typecast: false, useColumnId: true },
    }),
  },
  {
    type: 'airtable:upsertRecord',
    label: 'Airtable · Upsert record',
    group: 'Airtable',
    description: 'Update when a record id is given, otherwise create',
    make: (id) => ({
      id,
      module: 'airtable:upsertRecord',
      version: 3,
      parameters: { __IMTCONN__: '' as unknown as number },
      mapper: { recordId: '', base: '', table: '', record: {}, typecast: false, useColumnId: true },
    }),
  },
  {
    type: 'airtable:makeApiCall',
    label: 'Airtable · API call',
    group: 'Airtable',
    description: 'Raw Airtable REST call (e.g. PATCH v0/base/table/rec…)',
    make: (id) => ({
      id,
      module: 'airtable:makeApiCall',
      version: 3,
      parameters: { __IMTCONN__: '' as unknown as number },
      mapper: { url: 'v0/', method: 'GET', headers: [{ key: 'Content-Type', value: 'application/json' }], body: '' },
    }),
  },
  {
    type: 'builtin:BasicFeeder',
    label: 'Iterator',
    group: 'Flow control',
    description: 'Split an array into bundles; downstream runs once per item',
    make: (id) => ({ id, module: 'builtin:BasicFeeder', version: 1, parameters: {}, mapper: { array: '' } }),
  },
  {
    type: 'builtin:BasicRouter',
    label: 'Router',
    group: 'Flow control',
    description: 'Fan out into parallel routes (each can have its own filters)',
    make: (id) => ({ id, module: 'builtin:BasicRouter', version: 1, mapper: null, routes: [{ flow: [] }, { flow: [] }] }),
  },
  {
    type: 'builtin:BasicIfElse',
    label: 'If / Else',
    group: 'Flow control',
    description: 'Run the first branch whose conditions match, then continue',
    make: (id) => ({
      id,
      module: 'builtin:BasicIfElse',
      version: 1,
      mapper: null,
      branches: [
        { type: 'condition', label: '', merge: true, disabled: false, conditions: [[]], flow: [] },
        { type: 'else', label: '', merge: true, disabled: false, flow: [] },
      ],
    }),
  },
  {
    type: 'builtin:BasicMerge',
    label: 'Merge',
    group: 'Flow control',
    description: 'Merge point — add a filter to stop unwanted bundles',
    make: (id) => ({ id, module: 'builtin:BasicMerge', version: 1, mapper: null }),
  },
  {
    type: 'util:SetVariable2',
    label: 'Set variable',
    group: 'Tools',
    description: 'Store a value; read it later via Get variables or {{id.name}}',
    make: (id) => ({
      id,
      module: 'util:SetVariable2',
      version: 1,
      parameters: {},
      mapper: { name: 'myVar', scope: 'roundtrip', value: '' },
    }),
  },
  {
    type: 'util:GetVariables',
    label: 'Get variables',
    group: 'Tools',
    description: 'Read stored variables into this point of the flow',
    make: (id) => ({ id, module: 'util:GetVariables', version: 1, parameters: {}, mapper: { variables: [] } }),
  },
  {
    type: 'util:TextAggregator',
    label: 'Text aggregator',
    group: 'Tools',
    description: 'Join a value across all bundles of an iterator',
    make: (id) => ({
      id,
      module: 'util:TextAggregator',
      version: 1,
      parameters: { feeder: '' as unknown as number, rowSeparator: 'other', otherRowSeparator: ', ' },
      mapper: { value: '' },
    }),
  },
  {
    type: 'util:ComposeTransformer',
    label: 'Compose text',
    group: 'Tools',
    description: 'Build a string/value from mapped expressions',
    make: (id) => ({ id, module: 'util:ComposeTransformer', version: 1, parameters: {}, mapper: { value: '' } }),
  },
  {
    type: 'json:ParseJSON',
    label: 'Parse JSON',
    group: 'Tools',
    description: 'Parse a JSON string into mappable data',
    make: (id) => ({ id, module: 'json:ParseJSON', version: 1, parameters: {}, mapper: { json: '' } }),
  },
  {
    type: 'builtin:BasicSleep',
    label: 'Sleep',
    group: 'Tools',
    description: 'Pause the flow (max 10s)',
    make: (id) => ({ id, module: 'builtin:BasicSleep', version: 1, parameters: {}, mapper: { delay: '1' } }),
  },
];

export const FILTER_OPERATORS: { value: string; label: string }[] = [
  { value: 'exist', label: 'exists' },
  { value: 'notexist', label: 'does not exist' },
  { value: 'text:equal', label: 'text: equal to' },
  { value: 'text:notequal', label: 'text: not equal to' },
  { value: 'text:contain', label: 'text: contains' },
  { value: 'text:notcontain', label: 'text: does not contain' },
  { value: 'text:startwith', label: 'text: starts with' },
  { value: 'text:endwith', label: 'text: ends with' },
  { value: 'number:equal', label: 'number: equal to' },
  { value: 'number:notequal', label: 'number: not equal to' },
  { value: 'number:greater', label: 'number: greater than' },
  { value: 'number:greaterorequal', label: 'number: greater or equal' },
  { value: 'number:less', label: 'number: less than' },
  { value: 'number:lessorequal', label: 'number: less or equal' },
  { value: 'boolean:equal', label: 'boolean: equal to' },
  { value: 'array:contain', label: 'array: contains' },
  { value: 'array:notcontain', label: 'array: does not contain' },
];
