// Module executors: HTTP, Airtable, util/tools.
// Each executor receives the evaluated blueprint module + scope and returns
// one or more output bundles.

import type { BlueprintModule, RunOptions, Scope } from './types';
import { evalTemplate, toDisplayString } from './expressions';

export interface ExecResult {
  /** Output bundles. Most modules emit exactly one; search modules may emit many. */
  bundles: unknown[];
  /** Request details for the log (external calls). */
  request?: unknown;
  /** Human summary for the log line. */
  summary?: string;
  dryRun?: boolean;
}

export class ModuleError extends Error {
  constructor(message: string, public details?: unknown) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Helpers

function asString(v: unknown): string {
  return toDisplayString(v);
}

async function timedFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function parseBody(res: Response, wantJson: boolean): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  const ct = res.headers.get('content-type') || '';
  if (wantJson || ct.includes('json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function resolveConnectionToken(
  mod: BlueprintModule,
  opts: RunOptions,
  fallbackVars: string[],
): { token?: string; connId?: string } {
  const connId = mod.parameters?.__IMTCONN__ != null ? String(mod.parameters.__IMTCONN__) : undefined;
  if (connId && opts.connections?.[connId]?.token) {
    return { token: opts.connections[connId]!.token, connId };
  }
  for (const name of fallbackVars) {
    const v = opts.variables?.[name];
    if (v) return { token: v, connId };
  }
  return { connId };
}

// ---------------------------------------------------------------------------
// http:ActionSendData

export async function execHttp(
  mod: BlueprintModule,
  scope: Scope,
  opts: RunOptions,
): Promise<ExecResult> {
  const m = (evalTemplate(mod.mapper ?? {}, scope) ?? {}) as Record<string, unknown>;
  const url0 = asString(m.url);
  if (!url0) throw new ModuleError('HTTP module has no URL');
  const method = (asString(m.method) || 'get').toUpperCase();

  const headers: Record<string, string> = {};
  if (Array.isArray(m.headers)) {
    for (const h of m.headers as Array<Record<string, unknown>>) {
      const name = asString(h?.name ?? h?.key);
      if (name) headers[name] = asString(h?.value);
    }
  }
  const u = new URL(url0);
  if (Array.isArray(m.qs)) {
    for (const q of m.qs as Array<Record<string, unknown>>) {
      const name = asString(q?.name ?? q?.key);
      if (name) u.searchParams.append(name, asString(q?.value));
    }
  }

  let body: string | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    const bodyType = asString(m.bodyType);
    if (bodyType === 'raw' || !bodyType) {
      body = m.data !== undefined && m.data !== null ? asString(m.data) : undefined;
      const ct = asString(m.contentType);
      if (ct && ct !== 'custom' && !headers['Content-Type'] && !headers['Content-type'] && !headers['content-type']) {
        headers['Content-Type'] = ct;
      }
    } else if (bodyType === 'x_www_form_urlencoded') {
      const p = new URLSearchParams();
      for (const f of (m.formFields as Array<Record<string, unknown>>) ?? []) {
        p.append(asString(f?.name ?? f?.key), asString(f?.value));
      }
      body = p.toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else {
      body = m.data !== undefined ? asString(m.data) : undefined;
    }
  }
  if (m.authUser || m.authPass) {
    headers['Authorization'] =
      'Basic ' + Buffer.from(`${asString(m.authUser)}:${asString(m.authPass)}`).toString('base64');
  }

  const request = { url: u.toString(), method, headers: redactHeaders(headers), body };
  if (opts.dryRun) {
    return { bundles: [{ statusCode: 0, headers: {}, data: {} }], request, summary: `[dry-run] ${method} ${u.toString()}`, dryRun: true };
  }

  const timeoutMs = Number(m.timeout) > 0 ? Number(m.timeout) * 1000 : opts.requestTimeoutMs ?? 40000;
  const res = await timedFetch(u.toString(), { method, headers, body }, timeoutMs);
  const data = await parseBody(res, m.parseResponse === true || m.parseResponse === 'true');
  const output = {
    statusCode: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    data,
  };
  const handleErrors = mod.parameters?.handleErrors === true;
  if (handleErrors && (res.status < 200 || res.status >= 400)) {
    throw new ModuleError(`HTTP ${res.status} from ${u.hostname}`, output);
  }
  return { bundles: [output], request, summary: `${method} ${u.toString()} → ${res.status}` };
}

function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    out[k] = /authorization|api[-_]?key|token|secret/i.test(k) && v.length > 12 ? v.slice(0, 12) + '…[redacted]' : v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Airtable

const AIRTABLE_API = 'https://api.airtable.com';

function airtableAuth(mod: BlueprintModule, opts: RunOptions): string {
  const { token, connId } = resolveConnectionToken(mod, opts, ['AIRTABLE_TOKEN', 'AIRTABLE_API_KEY']);
  if (!token) {
    throw new ModuleError(
      `No Airtable token configured${connId ? ` for connection ${connId}` : ''}. ` +
        `Add it under Connections (id ${connId ?? '?'}) or set an AIRTABLE_TOKEN variable.`,
    );
  }
  return `Bearer ${token}`;
}

async function airtableFetch(
  path: string,
  init: RequestInit,
  auth: string,
  opts: RunOptions,
): Promise<{ status: number; data: unknown }> {
  const url = path.startsWith('http') ? path : `${AIRTABLE_API}/${path.replace(/^\//, '')}`;
  const headers: Record<string, string> = {
    Authorization: auth,
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  };
  const res = await timedFetch(url, { ...init, headers }, opts.requestTimeoutMs ?? 40000);
  const data = await parseBody(res, true);
  if (res.status === 429) {
    // one retry after Airtable's mandated 30s is too slow for serverless; wait 1.2s and retry once
    await new Promise((r) => setTimeout(r, 1200));
    const res2 = await timedFetch(url, { ...init, headers }, opts.requestTimeoutMs ?? 40000);
    return { status: res2.status, data: await parseBody(res2, true) };
  }
  return { status: res.status, data };
}

function flattenRecord(rec: Record<string, unknown>): Record<string, unknown> {
  const fields = (rec.fields as Record<string, unknown>) ?? {};
  return { id: rec.id, createdTime: rec.createdTime, ...fields };
}

function buildFields(record: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (record && typeof record === 'object') {
    for (const [k, v] of Object.entries(record as Record<string, unknown>)) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) {
        const arr = v.filter((x) => x !== undefined && x !== null && x !== '');
        if (arr.length === 0) continue;
        out[k] = arr;
        continue;
      }
      out[k] = v;
    }
  }
  return out;
}

function requireAirtableStatus(status: number, data: unknown, what: string): void {
  if (status < 200 || status >= 300) {
    const msg =
      (data as { error?: { message?: string; type?: string } })?.error?.message ??
      (typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data)?.slice(0, 300));
    throw new ModuleError(`Airtable ${what} failed (${status}): ${msg}`, data);
  }
}

export async function execAirtable(
  mod: BlueprintModule,
  scope: Scope,
  opts: RunOptions,
): Promise<ExecResult> {
  const action = mod.module.split(':')[1];
  const m = (evalTemplate(mod.mapper ?? {}, scope) ?? {}) as Record<string, unknown>;

  if (opts.dryRun) {
    const summary = `[dry-run] airtable:${action} ${asString(m.base)}/${asString(m.table)}`;
    if (action === 'ActionSearchRecords') return { bundles: [{}], request: m, summary, dryRun: true };
    return { bundles: [{ id: 'recDRYRUN0000000', ...buildFields(m.record) }], request: m, summary, dryRun: true };
  }

  const auth = airtableAuth(mod, opts);
  const base = asString(m.base);
  const table = asString(m.table);

  switch (action) {
    case 'ActionSearchRecords': {
      const params = new URLSearchParams();
      const formula = asString(m.formula);
      if (formula) params.set('filterByFormula', formula);
      const max = Number(m.maxRecords);
      if (max > 0) params.set('maxRecords', String(max));
      if (m.view) params.set('view', asString(m.view));
      const path = `v0/${base}/${encodeURIComponent(table)}?${params.toString()}`;
      const { status, data } = await airtableFetch(path, { method: 'GET' }, auth, opts);
      requireAirtableStatus(status, data, 'search');
      const records = ((data as { records?: Record<string, unknown>[] })?.records ?? []).map(flattenRecord);
      const bundles: unknown[] = records.length > 0 ? records : [{}]; // empty bundle lets exist/notexist filters route
      return {
        bundles,
        request: { path, formula },
        summary: `search ${table}: ${records.length} record(s)`,
      };
    }
    case 'ActionCreateRecord': {
      const fields = buildFields(m.record);
      const body = JSON.stringify({ fields, typecast: m.typecast === true });
      const path = `v0/${base}/${encodeURIComponent(table)}`;
      const { status, data } = await airtableFetch(path, { method: 'POST', body }, auth, opts);
      requireAirtableStatus(status, data, 'create');
      const rec = flattenRecord(data as Record<string, unknown>);
      return { bundles: [rec], request: { path, fields }, summary: `created ${rec.id}` };
    }
    case 'ActionUpdateRecord':
    case 'ActionUpdateRecords': {
      const id = asString(m.id);
      if (!id) throw new ModuleError('Airtable update: no record id resolved');
      const fields = buildFields(m.record);
      const body = JSON.stringify({ fields, typecast: m.typecast === true });
      const path = `v0/${base}/${encodeURIComponent(table)}/${id}`;
      const { status, data } = await airtableFetch(path, { method: 'PATCH', body }, auth, opts);
      requireAirtableStatus(status, data, 'update');
      const rec = flattenRecord(data as Record<string, unknown>);
      return { bundles: [rec], request: { path, fields }, summary: `updated ${id}` };
    }
    case 'upsertRecord': {
      const id = asString(m.recordId);
      const fields = buildFields(m.record);
      const body = JSON.stringify({ fields, typecast: m.typecast === true });
      const path = id
        ? `v0/${base}/${encodeURIComponent(table)}/${id}`
        : `v0/${base}/${encodeURIComponent(table)}`;
      const { status, data } = await airtableFetch(path, { method: id ? 'PATCH' : 'POST', body }, auth, opts);
      requireAirtableStatus(status, data, 'upsert');
      const rec = flattenRecord(data as Record<string, unknown>);
      return { bundles: [rec], request: { path, fields }, summary: `upserted ${rec.id}` };
    }
    case 'makeApiCall': {
      const path = asString(m.url);
      const method = (asString(m.method) || 'GET').toUpperCase();
      const headers: Record<string, string> = {};
      if (Array.isArray(m.headers)) {
        for (const h of m.headers as Array<Record<string, unknown>>) {
          const name = asString(h?.key ?? h?.name);
          if (name) headers[name] = asString(h?.value);
        }
      }
      let body: string | undefined;
      if (method !== 'GET' && m.body !== undefined && m.body !== null && m.body !== '') {
        body = typeof m.body === 'string' ? m.body : JSON.stringify(m.body);
        // Blueprints often assemble JSON bodies with string surgery; validate
        // and, when broken, try trailing-comma cleanup before giving up.
        try {
          JSON.parse(body);
        } catch {
          const repaired = body.replace(/,\s*([\]}])/g, '$1');
          try {
            JSON.parse(repaired);
            body = repaired;
          } catch {
            throw new ModuleError(`makeApiCall body is not valid JSON:\n${body.slice(0, 500)}`);
          }
        }
      }
      const { status, data } = await airtableFetch(path, { method, headers, body }, auth, opts);
      requireAirtableStatus(status, data, `API call ${method} ${path}`);
      return { bundles: [{ statusCode: status, body: data }], request: { path, method, body }, summary: `${method} ${path} → ${status}` };
    }
    case 'ActionDeleteRecord': {
      const id = asString(m.id);
      const path = `v0/${base}/${encodeURIComponent(table)}/${id}`;
      const { status, data } = await airtableFetch(path, { method: 'DELETE' }, auth, opts);
      requireAirtableStatus(status, data, 'delete');
      return { bundles: [{ id, deleted: true }], summary: `deleted ${id}` };
    }
    case 'ActionGetRecord': {
      const id = asString(m.id);
      const path = `v0/${base}/${encodeURIComponent(table)}/${id}`;
      const { status, data } = await airtableFetch(path, { method: 'GET' }, auth, opts);
      requireAirtableStatus(status, data, 'get');
      return { bundles: [flattenRecord(data as Record<string, unknown>)], summary: `got ${id}` };
    }
    default:
      throw new ModuleError(`Unsupported Airtable action: ${action}`);
  }
}
