'use client';

// Make.com-style visual scenario editor: circular module nodes on a canvas,
// routers fanning out into routes, "+" buttons to insert modules, and an
// inspector panel for module settings and filters. All edits mutate the
// blueprint JSON, so the visual and JSON views stay interchangeable.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Blueprint, BlueprintModule, FilterConditions } from '@/lib/engine/types';
import {
  addRouteOrBranch,
  CATALOG,
  childFlows,
  defaultName,
  deleteModule,
  FILTER_OPERATORS,
  findModule,
  type FlowPath,
  getFlow,
  insertModule,
  moduleStyle,
  nextId,
  normalizeBlueprint,
  removeRouteOrBranch,
  rootFlow,
  updateModule,
} from '@/lib/editor';

const R = 26; // node radius
const X_STEP = 135;
const Y_STEP = 118;
const PAD = 70;

interface LNode {
  mod: BlueprintModule;
  x: number;
  y: number;
  path: FlowPath;
  index: number;
}
interface LEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  filtered?: boolean;
  label?: string;
  toId?: number;
}
interface LAdd {
  x: number;
  y: number;
  path: FlowPath;
  index: number;
}

interface Layout {
  nodes: LNode[];
  edges: LEdge[];
  adds: LAdd[];
  width: number;
  height: number;
}

function flowHeight(flow: BlueprintModule[]): number {
  if (!flow || flow.length === 0) return Y_STEP;
  return Math.max(...flow.map(moduleHeight));
}
function moduleHeight(mod: BlueprintModule): number {
  const cf = childFlows(mod);
  if (!cf) return Y_STEP;
  return Math.max(Y_STEP, cf.flows.reduce((a, f) => a + flowHeight(f), 0));
}

function branchLabel(mod: BlueprintModule, idx: number): string {
  if (mod.branches) {
    const b = mod.branches[idx];
    if (b?.label) return b.label;
    return b?.type === 'else' ? 'else' : `if #${idx + 1}`;
  }
  return `route ${idx + 1}`;
}

function layoutFlow(
  flow: BlueprintModule[],
  path: FlowPath,
  x0: number,
  yTop: number,
  out: Layout,
): { width: number; rowY: number; entry: { x: number; y: number; filtered?: boolean } | null } {
  const h = flowHeight(flow);
  const rowY = yTop + h / 2;
  if (!flow || flow.length === 0) {
    out.adds.push({ x: x0, y: rowY, path, index: 0 });
    return { width: X_STEP, rowY, entry: null };
  }
  let cur = x0;
  let prev: { x: number; y: number } | null = null;
  let entry: { x: number; y: number; filtered?: boolean } | null = null;
  flow.forEach((mod, i) => {
    const nodeX = cur;
    if (i === 0) entry = { x: nodeX, y: rowY, filtered: !!mod.filter };
    if (prev) {
      out.edges.push({ x1: prev.x, y1: prev.y, x2: nodeX, y2: rowY, filtered: !!mod.filter, toId: mod.id });
      out.adds.push({ x: (prev.x + nodeX) / 2, y: rowY, path, index: i });
    }
    out.nodes.push({ mod, x: nodeX, y: rowY, path, index: i });
    prev = { x: nodeX, y: rowY };

    const cf = childFlows(mod);
    if (cf) {
      const totalH = cf.flows.reduce((a, f) => a + flowHeight(f), 0);
      let childY = rowY - totalH / 2;
      const childX = cur + X_STEP;
      let maxW = 0;
      cf.flows.forEach((f, j) => {
        const seg: FlowPath = [...path, { id: mod.id, slot: cf.slot, idx: j }];
        const block = layoutFlow(f, seg, childX, childY, out);
        const target = block.entry ?? { x: childX, y: block.rowY };
        out.edges.push({
          x1: nodeX,
          y1: rowY,
          x2: target.x,
          y2: target.y,
          filtered: block.entry?.filtered,
          label: branchLabel(mod, j),
          toId: f[0]?.id,
        });
        maxW = Math.max(maxW, block.width);
        childY += flowHeight(f);
      });
      cur += X_STEP + maxW;
    } else {
      cur += X_STEP;
    }
  });
  // end-of-flow add point
  out.adds.push({ x: (prev as unknown as { x: number }).x + X_STEP * 0.55, y: rowY, path, index: flow.length });
  return { width: cur - x0, rowY, entry };
}

function computeLayout(bp: Blueprint): Layout {
  const out: Layout = { nodes: [], edges: [], adds: [], width: 0, height: 0 };
  const flow = rootFlow(bp);
  const h = flowHeight(flow);
  const block = layoutFlow(flow, [], PAD, PAD, out);
  out.width = PAD * 2 + block.width + X_STEP;
  out.height = PAD * 2 + h;
  return out;
}

// ---------------------------------------------------------------------------
// Small form primitives

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="fld">
      <span>{label}</span>
      {children}
    </label>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  mono = true,
}: {
  value: unknown;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <input
      type="text"
      className={mono ? '' : 'sans'}
      value={value == null ? '' : String(value)}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function TextArea({
  value,
  onChange,
  rows = 4,
  placeholder,
}: {
  value: unknown;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <textarea
      className="mini-code"
      rows={rows}
      value={value == null ? '' : String(value)}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function Check({ label, value, onChange }: { label: string; value: unknown; onChange: (v: boolean) => void }) {
  return (
    <label className="chk">
      <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function PairList({
  items,
  keyField,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  items: Array<Record<string, unknown>>;
  keyField: 'name' | 'key';
  onChange: (items: Array<Record<string, unknown>>) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
}) {
  const rows = Array.isArray(items) ? items : [];
  return (
    <div className="pairlist">
      {rows.map((it, i) => (
        <div className="pair" key={i}>
          <input
            type="text"
            value={String(it?.[keyField] ?? '')}
            placeholder={keyPlaceholder}
            onChange={(e) => {
              const next = rows.map((r, j) => (j === i ? { ...r, [keyField]: e.target.value } : r));
              onChange(next);
            }}
          />
          <input
            type="text"
            value={String(it?.value ?? '')}
            placeholder={valuePlaceholder}
            onChange={(e) => {
              const next = rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r));
              onChange(next);
            }}
          />
          <button className="small" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button className="small" onClick={() => onChange([...rows, { [keyField]: '', value: '' }])}>
        + add
      </button>
    </div>
  );
}

function RecordEditor({
  record,
  onChange,
}: {
  record: Record<string, unknown>;
  onChange: (rec: Record<string, unknown>) => void;
}) {
  const entries = Object.entries(record ?? {});
  const setEntry = (i: number, k: string, v: unknown) => {
    const next: Record<string, unknown> = {};
    entries.forEach(([ek, ev], j) => {
      if (j === i) next[k] = v;
      else next[ek] = ev;
    });
    onChange(next);
  };
  return (
    <div className="pairlist">
      {entries.map(([k, v], i) => (
        <div className="pair" key={i}>
          <input type="text" value={k} placeholder="field id / name" onChange={(e) => setEntry(i, e.target.value, v)} />
          <input
            type="text"
            value={Array.isArray(v) ? JSON.stringify(v) : String(v ?? '')}
            placeholder="value or {{expression}}"
            onChange={(e) => {
              let val: unknown = e.target.value;
              const t = e.target.value.trim();
              if (t.startsWith('[')) {
                try {
                  val = JSON.parse(t);
                } catch {
                  /* keep string until valid */
                }
              }
              setEntry(i, k, val);
            }}
          />
          <button
            className="small"
            onClick={() => {
              const next = { ...record };
              delete next[k];
              onChange(next);
            }}
          >
            ✕
          </button>
        </div>
      ))}
      <button className="small" onClick={() => onChange({ ...record, '': '' })}>
        + add field
      </button>
    </div>
  );
}

function ConditionsEditor({
  conditions,
  onChange,
}: {
  conditions: FilterConditions;
  onChange: (c: FilterConditions) => void;
}) {
  const groups = conditions?.length ? conditions : [[]];
  const needsB = (op: string) => op !== 'exist' && op !== 'notexist';
  return (
    <div className="conds">
      {groups.map((group, gi) => (
        <div key={gi} className="cond-group">
          {gi > 0 ? <div className="or-sep">OR</div> : null}
          {group.map((c, ci) => (
            <div key={ci} className="cond-row">
              <input
                type="text"
                value={c.a ?? ''}
                placeholder="{{6.id}}"
                onChange={(e) => {
                  const next = groups.map((g, j) =>
                    j === gi ? g.map((cc, k) => (k === ci ? { ...cc, a: e.target.value } : cc)) : g,
                  );
                  onChange(next);
                }}
              />
              <select
                value={c.o}
                onChange={(e) => {
                  const next = groups.map((g, j) =>
                    j === gi ? g.map((cc, k) => (k === ci ? { ...cc, o: e.target.value } : cc)) : g,
                  );
                  onChange(next);
                }}
              >
                {FILTER_OPERATORS.map((op) => (
                  <option key={op.value} value={op.value}>
                    {op.label}
                  </option>
                ))}
              </select>
              {needsB(c.o) ? (
                <input
                  type="text"
                  value={c.b ?? ''}
                  placeholder="value"
                  onChange={(e) => {
                    const next = groups.map((g, j) =>
                      j === gi ? g.map((cc, k) => (k === ci ? { ...cc, b: e.target.value } : cc)) : g,
                    );
                    onChange(next);
                  }}
                />
              ) : (
                <span />
              )}
              <button
                className="small"
                onClick={() => {
                  const next = groups
                    .map((g, j) => (j === gi ? g.filter((_, k) => k !== ci) : g))
                    .filter((g, j) => g.length > 0 || j === 0 || groups.length === 1);
                  onChange(next);
                }}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            className="small"
            onClick={() => onChange(groups.map((g, j) => (j === gi ? [...g, { a: '', o: 'exist' }] : g)))}
          >
            + AND condition
          </button>
        </div>
      ))}
      <button className="small" onClick={() => onChange([...groups, [{ a: '', o: 'exist' }]])}>
        + OR group
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inspector

function Inspector({
  bp,
  id,
  onChange,
  onClose,
  onDelete,
}: {
  bp: Blueprint;
  id: number;
  onChange: (bp: Blueprint) => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  const mod = findModule(bp, id);
  const [rawOpen, setRawOpen] = useState(false);
  const [rawText, setRawText] = useState('');
  const [rawErr, setRawErr] = useState<string | null>(null);
  if (!mod) return null;
  const style = moduleStyle(mod.module);
  const mapper = (mod.mapper ?? {}) as Record<string, unknown>;
  const params = (mod.parameters ?? {}) as Record<string, unknown>;

  const patchMapper = (key: string, value: unknown) =>
    onChange(
      updateModule(bp, id, (m) => {
        (m.mapper as Record<string, unknown>) ??= {};
        (m.mapper as Record<string, unknown>)[key] = value;
      }),
    );
  const patchParam = (key: string, value: unknown) =>
    onChange(
      updateModule(bp, id, (m) => {
        m.parameters ??= {};
        (m.parameters as Record<string, unknown>)[key] = value;
      }),
    );
  const setName = (name: string) =>
    onChange(
      updateModule(bp, id, (m) => {
        m.metadata ??= {};
        m.metadata.designer = { ...(m.metadata.designer ?? {}), name };
      }),
    );

  const type = mod.module;
  const isAirtable = type.startsWith('airtable:');
  const hasRoutes = !!mod.routes;
  const hasBranches = !!mod.branches;

  return (
    <div className="inspector">
      <div className="insp-head">
        <span className="node-dot" style={{ background: style.color }}>
          {style.glyph}
        </span>
        <div className="insp-title">
          <div className="type">
            {type} <span className="badge">id {mod.id}</span>
          </div>
          <input
            type="text"
            className="sans"
            value={mod.metadata?.designer?.name ?? ''}
            placeholder={defaultName(mod)}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <button className="small" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="insp-body">
        {/* ---- type-specific settings ---- */}
        {type === 'http:ActionSendData' ? (
          <>
            <Field label="URL">
              <TextInput value={mapper.url} onChange={(v) => patchMapper('url', v)} placeholder="https://api.example.com/…" />
            </Field>
            <Field label="Method">
              <select value={String(mapper.method ?? 'get')} onChange={(e) => patchMapper('method', e.target.value)}>
                {['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].map((m) => (
                  <option key={m} value={m}>
                    {m.toUpperCase()}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Headers (use {{var.TOKEN}} for secrets)">
              <PairList
                items={(mapper.headers as Array<Record<string, unknown>>) ?? []}
                keyField="name"
                onChange={(v) => patchMapper('headers', v)}
                keyPlaceholder="Authorization"
                valuePlaceholder="Bearer {{var.MY_TOKEN}}"
              />
            </Field>
            <Field label="Query string">
              <PairList
                items={(mapper.qs as Array<Record<string, unknown>>) ?? []}
                keyField="name"
                onChange={(v) => patchMapper('qs', v)}
                keyPlaceholder="param"
                valuePlaceholder="value"
              />
            </Field>
            <Field label="Content type">
              <select
                value={String(mapper.contentType ?? 'application/json')}
                onChange={(e) => patchMapper('contentType', e.target.value)}
              >
                {['application/json', 'text/plain', 'application/xml', 'text/html', 'custom'].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </Field>
            <Field label="Request body">
              <TextArea value={mapper.data} onChange={(v) => patchMapper('data', v)} rows={5} placeholder='{"key": "{{1.value}}"}' />
            </Field>
            <Check label="Parse response (JSON)" value={mapper.parseResponse} onChange={(v) => patchMapper('parseResponse', v)} />
            <Check label="Treat non-2xx/3xx as errors" value={params.handleErrors} onChange={(v) => patchParam('handleErrors', v)} />
          </>
        ) : null}

        {isAirtable ? (
          <>
            <Field label="Connection id (__IMTCONN__)">
              <TextInput
                value={params.__IMTCONN__ ?? ''}
                onChange={(v) => patchParam('__IMTCONN__', v)}
                placeholder="e.g. 10209480 — map to a token in Connections"
              />
            </Field>
            {type !== 'airtable:makeApiCall' ? (
              <>
                <Field label="Base id">
                  <TextInput value={mapper.base} onChange={(v) => patchMapper('base', v)} placeholder="appXXXXXXXXXXXXXX" />
                </Field>
                <Field label="Table id / name">
                  <TextInput value={mapper.table} onChange={(v) => patchMapper('table', v)} placeholder="tblXXXXXXXXXXXXXX" />
                </Field>
              </>
            ) : null}
            {type === 'airtable:ActionSearchRecords' ? (
              <>
                <Field label="Formula">
                  <TextArea value={mapper.formula} onChange={(v) => patchMapper('formula', v)} rows={3} placeholder="{Name} = '{{4.name}}'" />
                </Field>
                <Field label="Max records">
                  <TextInput value={mapper.maxRecords} onChange={(v) => patchMapper('maxRecords', v)} />
                </Field>
              </>
            ) : null}
            {type === 'airtable:ActionUpdateRecords' ? (
              <Field label="Record id">
                <TextInput value={mapper.id} onChange={(v) => patchMapper('id', v)} placeholder="{{6.id}}" />
              </Field>
            ) : null}
            {type === 'airtable:upsertRecord' ? (
              <Field label="Record id (empty = create)">
                <TextInput value={mapper.recordId} onChange={(v) => patchMapper('recordId', v)} placeholder="{{16.activeMrdId}}" />
              </Field>
            ) : null}
            {['airtable:ActionCreateRecord', 'airtable:ActionUpdateRecords', 'airtable:upsertRecord'].includes(type) ? (
              <>
                <Field label="Record fields">
                  <RecordEditor
                    record={(mapper.record as Record<string, unknown>) ?? {}}
                    onChange={(rec) => patchMapper('record', rec)}
                  />
                </Field>
                <Check label="Use column ids as keys" value={mapper.useColumnId} onChange={(v) => patchMapper('useColumnId', v)} />
                <Check label="Typecast (smart links)" value={mapper.typecast} onChange={(v) => patchMapper('typecast', v)} />
              </>
            ) : null}
            {type === 'airtable:makeApiCall' ? (
              <>
                <Field label="URL (relative to api.airtable.com)">
                  <TextInput value={mapper.url} onChange={(v) => patchMapper('url', v)} placeholder="v0/appXXX/tblYYY/recZZZ" />
                </Field>
                <Field label="Method">
                  <select value={String(mapper.method ?? 'GET')} onChange={(e) => patchMapper('method', e.target.value)}>
                    {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Body (JSON)">
                  <TextArea value={mapper.body} onChange={(v) => patchMapper('body', v)} rows={6} />
                </Field>
              </>
            ) : null}
          </>
        ) : null}

        {type === 'builtin:BasicFeeder' ? (
          <Field label="Array to iterate">
            <TextInput value={mapper.array} onChange={(v) => patchMapper('array', v)} placeholder="{{3.data.Data}}" />
          </Field>
        ) : null}

        {type === 'util:SetVariable2' ? (
          <>
            <Field label="Variable name">
              <TextInput value={mapper.name} onChange={(v) => patchMapper('name', v)} />
            </Field>
            <Field label="Value">
              <TextInput value={mapper.value} onChange={(v) => patchMapper('value', v)} placeholder="{{13.id}}" />
            </Field>
          </>
        ) : null}

        {type === 'util:GetVariables' ? (
          <Field label="Variable names (one per line)">
            <TextArea
              value={Array.isArray(mapper.variables) ? (mapper.variables as unknown[]).join('\n') : ''}
              onChange={(v) => patchMapper('variables', v.split('\n').map((s) => s.trim()).filter(Boolean))}
              rows={3}
            />
          </Field>
        ) : null}

        {type === 'util:TextAggregator' ? (
          <>
            <Field label="Source iterator (module id)">
              <TextInput value={params.feeder} onChange={(v) => patchParam('feeder', Number(v) || v)} placeholder="28" />
            </Field>
            <Field label="Separator">
              <TextInput
                value={params.otherRowSeparator}
                onChange={(v) => {
                  patchParam('rowSeparator', 'other');
                  patchParam('otherRowSeparator', v);
                }}
                placeholder=", "
              />
            </Field>
            <Field label="Value per bundle">
              <TextInput value={mapper.value} onChange={(v) => patchMapper('value', v)} placeholder="{{28.dosagedays}}" />
            </Field>
          </>
        ) : null}

        {type === 'json:ParseJSON' ? (
          <Field label="JSON string">
            <TextArea value={mapper.json} onChange={(v) => patchMapper('json', v)} rows={4} placeholder="{{1.data}}" />
          </Field>
        ) : null}

        {type === 'util:ComposeTransformer' ? (
          <Field label="Value">
            <TextArea value={mapper.value} onChange={(v) => patchMapper('value', v)} rows={4} />
          </Field>
        ) : null}

        {type === 'builtin:BasicSleep' ? (
          <Field label="Delay (seconds, max 10)">
            <TextInput value={mapper.delay} onChange={(v) => patchMapper('delay', v)} />
          </Field>
        ) : null}

        {/* ---- routes / branches ---- */}
        {hasRoutes ? (
          <div className="insp-section">
            <h3>Routes ({mod.routes!.length})</h3>
            {mod.routes!.map((r, i) => (
              <div key={i} className="route-row">
                <span>route {i + 1} — {r.flow?.length ?? 0} module(s)</span>
                {mod.routes!.length > 1 ? (
                  <button
                    className="small"
                    onClick={() => {
                      if ((r.flow?.length ?? 0) === 0 || window.confirm(`Delete route ${i + 1} and its ${r.flow!.length} module(s)?`))
                        onChange(removeRouteOrBranch(bp, id, i));
                    }}
                  >
                    delete
                  </button>
                ) : null}
              </div>
            ))}
            <button className="small" onClick={() => onChange(addRouteOrBranch(bp, id))}>
              + add route
            </button>
          </div>
        ) : null}

        {hasBranches ? (
          <div className="insp-section">
            <h3>Branches</h3>
            {mod.branches!.map((b, i) => (
              <div key={i} className="branch-box">
                <div className="route-row">
                  <input
                    type="text"
                    className="sans"
                    value={b.label ?? ''}
                    placeholder={b.type === 'else' ? 'else' : `if #${i + 1}`}
                    disabled={b.type === 'else'}
                    onChange={(e) =>
                      onChange(
                        updateModule(bp, id, (m) => {
                          m.branches![i].label = e.target.value;
                        }),
                      )
                    }
                  />
                  {mod.branches!.length > 1 ? (
                    <button
                      className="small"
                      onClick={() => {
                        if ((b.flow?.length ?? 0) === 0 || window.confirm(`Delete this branch and its ${b.flow!.length} module(s)?`))
                          onChange(removeRouteOrBranch(bp, id, i));
                      }}
                    >
                      delete
                    </button>
                  ) : null}
                </div>
                {b.type !== 'else' ? (
                  <ConditionsEditor
                    conditions={(b.conditions ?? [[]]) as FilterConditions}
                    onChange={(c) =>
                      onChange(
                        updateModule(bp, id, (m) => {
                          m.branches![i].conditions = c;
                        }),
                      )
                    }
                  />
                ) : (
                  <div className="hint">runs when no other branch matches</div>
                )}
              </div>
            ))}
            <button className="small" onClick={() => onChange(addRouteOrBranch(bp, id))}>
              + add branch
            </button>
          </div>
        ) : null}

        {/* ---- filter ---- */}
        <div className="insp-section">
          <h3>Filter (gates this module and everything after it)</h3>
          {mod.filter ? (
            <>
              <Field label="Filter name">
                <TextInput
                  mono={false}
                  value={mod.filter.name ?? ''}
                  onChange={(v) =>
                    onChange(
                      updateModule(bp, id, (m) => {
                        m.filter!.name = v;
                      }),
                    )
                  }
                />
              </Field>
              <ConditionsEditor
                conditions={mod.filter.conditions ?? [[]]}
                onChange={(c) =>
                  onChange(
                    updateModule(bp, id, (m) => {
                      m.filter = { name: m.filter?.name ?? '', conditions: c };
                    }),
                  )
                }
              />
              <button
                className="small"
                onClick={() =>
                  onChange(
                    updateModule(bp, id, (m) => {
                      m.filter = null;
                    }),
                  )
                }
              >
                remove filter
              </button>
            </>
          ) : (
            <button
              className="small"
              onClick={() =>
                onChange(
                  updateModule(bp, id, (m) => {
                    m.filter = { name: '', conditions: [[{ a: '', o: 'exist' }]] };
                  }),
                )
              }
            >
              + add filter
            </button>
          )}
        </div>

        {/* ---- raw JSON ---- */}
        <div className="insp-section">
          <h3>
            <button
              className="small"
              onClick={() => {
                setRawOpen(!rawOpen);
                setRawText(JSON.stringify(mod, null, 2));
                setRawErr(null);
              }}
            >
              {rawOpen ? 'hide' : 'edit'} raw module JSON
            </button>
          </h3>
          {rawOpen ? (
            <>
              <TextArea value={rawText} onChange={setRawText} rows={12} />
              {rawErr ? <div className="error-text">{rawErr}</div> : null}
              <button
                className="small"
                onClick={() => {
                  try {
                    const parsed = JSON.parse(rawText) as BlueprintModule;
                    onChange(
                      updateModule(bp, id, (m) => {
                        Object.keys(m).forEach((k) => delete (m as unknown as Record<string, unknown>)[k]);
                        Object.assign(m, parsed, { id });
                      }),
                    );
                    setRawErr(null);
                  } catch (e) {
                    setRawErr(e instanceof Error ? e.message : String(e));
                  }
                }}
              >
                apply JSON
              </button>
            </>
          ) : null}
        </div>

        <div className="insp-section">
          <button className="danger" onClick={onDelete}>
            Delete module
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Module picker

function Picker({
  onPick,
  onClose,
}: {
  onPick: (entryType: string) => void;
  onClose: () => void;
}) {
  const groups = Array.from(new Set(CATALOG.map((c) => c.group)));
  return (
    <div className="picker-backdrop" onClick={onClose}>
      <div className="picker" onClick={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <b>Add a module</b>
          <button className="small" onClick={onClose}>
            ✕
          </button>
        </div>
        {groups.map((g) => (
          <div key={g}>
            <div className="picker-group">{g}</div>
            <div className="picker-grid">
              {CATALOG.filter((c) => c.group === g).map((c) => {
                const st = moduleStyle(c.type);
                return (
                  <button key={c.type} className="picker-item" onClick={() => onPick(c.type)}>
                    <span className="node-dot" style={{ background: st.color }}>
                      {st.glyph}
                    </span>
                    <span>
                      <b>{c.label}</b>
                      <small>{c.description}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main editor

export default function FlowEditor({
  blueprint,
  onChange,
}: {
  blueprint: Blueprint;
  onChange: (bp: Blueprint) => void;
}) {
  const bp = useMemo(() => normalizeBlueprint(blueprint), [blueprint]);
  const [selected, setSelected] = useState<number | null>(null);
  const [addAt, setAddAt] = useState<{ path: FlowPath; index: number } | null>(null);
  const [undoStack, setUndoStack] = useState<Blueprint[]>([]);

  const layout = useMemo(() => computeLayout(bp), [bp]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const scrolledOnce = useRef(false);

  const firstRootId = layout.nodes[0]?.mod.id;
  useEffect(() => {
    // Re-center when a different scenario is loaded (first module changed).
    scrolledOnce.current = false;
  }, [firstRootId]);

  // Center the start of the flow on first render of a blueprint.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || scrolledOnce.current) return;
    const first = layout.nodes[0];
    if (!first) return;
    wrap.scrollTo({ top: Math.max(0, first.y - wrap.clientHeight / 2), left: 0 });
    scrolledOnce.current = true;
  }, [layout]);

  const structural = (next: Blueprint) => {
    setUndoStack((s) => [...s.slice(-24), bp]);
    onChange(next);
  };
  const undo = () => {
    const prev = undoStack[undoStack.length - 1];
    if (prev) {
      setUndoStack((s) => s.slice(0, -1));
      onChange(prev);
      setSelected(null);
    }
  };

  const selectedLoc = useMemo(() => {
    if (selected == null) return null;
    return layout.nodes.find((n) => n.mod.id === selected) ?? null;
  }, [selected, layout]);

  return (
    <div className="floweditor">
      <div className="canvas-toolbar">
        <span className="hint">Click a module to configure it · click “+” to insert a module, router or filter</span>
        <span style={{ flex: 1 }} />
        <button className="small" disabled={undoStack.length === 0} onClick={undo}>
          ↩ undo
        </button>
      </div>
      <div className="canvas-wrap" ref={wrapRef}>
        <div className="canvas" style={{ width: layout.width, height: Math.max(layout.height, 320) }}>
          <svg width={layout.width} height={Math.max(layout.height, 320)}>
            {layout.edges.map((e, i) => {
              const x1 = e.x1 + R;
              const x2 = e.x2 - R;
              const mx = (x1 + x2) / 2;
              return (
                <g key={i}>
                  <path
                    d={`M ${x1} ${e.y1} C ${mx} ${e.y1}, ${mx} ${e.y2}, ${x2} ${e.y2}`}
                    fill="none"
                    stroke="#3f3f5a"
                    strokeWidth={2.5}
                  />
                  {e.label ? (
                    <text x={x1 + 8} y={e.y2 - 8} className="edge-label">
                      {e.label}
                    </text>
                  ) : null}
                  {e.filtered ? (
                    <g
                      transform={`translate(${x2 - 22}, ${e.y2})`}
                      className="filter-glyph"
                      onClick={() => e.toId != null && setSelected(e.toId)}
                    >
                      <circle r={9} fill="#1b1b28" stroke="#8b5cf6" strokeWidth={1.5} />
                      <path d="M -4 -3 L 4 -3 L 1 1 L 1 4 L -1 4 L -1 1 Z" fill="#c4b5fd" />
                    </g>
                  ) : null}
                </g>
              );
            })}
          </svg>
          {layout.adds.map((a, i) => (
            <button
              key={`add-${i}`}
              className="add-btn"
              style={{ left: a.x - 11, top: a.y - 11 }}
              title="Insert module here"
              onClick={() => setAddAt({ path: a.path, index: a.index })}
            >
              +
            </button>
          ))}
          {layout.nodes.map((n) => {
            const st = moduleStyle(n.mod.module);
            return (
              <div
                key={`node-${n.mod.id}-${n.index}`}
                className={`node ${selected === n.mod.id ? 'selected' : ''}`}
                style={{ left: n.x - R, top: n.y - R }}
                onClick={() => setSelected(n.mod.id)}
              >
                <div className="node-circle" style={{ background: st.color }}>
                  {st.glyph}
                </div>
                <div className="node-label">
                  <span>{defaultName(n.mod)}</span>
                  <small>{n.mod.id}</small>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {selected != null ? (
        <Inspector
          bp={bp}
          id={selected}
          onChange={onChange}
          onClose={() => setSelected(null)}
          onDelete={() => {
            const loc = selectedLoc;
            if (!loc) return;
            const cf = childFlows(loc.mod);
            const nested = cf ? cf.flows.reduce((a, f) => a + f.length, 0) : 0;
            if (nested === 0 || window.confirm(`Delete module ${loc.mod.id} and ${nested} nested module(s)?`)) {
              structural(deleteModule(bp, loc.path, loc.index));
              setSelected(null);
            }
          }}
        />
      ) : null}
      {addAt ? (
        <Picker
          onClose={() => setAddAt(null)}
          onPick={(type) => {
            const entry = CATALOG.find((c) => c.type === type)!;
            const mod = entry.make(nextId(bp));
            structural(insertModule(bp, addAt.path, addAt.index, mod));
            setAddAt(null);
            setSelected(mod.id);
          }}
        />
      ) : null}
    </div>
  );
}
