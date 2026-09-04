'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Blueprint, LogEntry, RunResult } from '@/lib/engine/types';
import { extractSecrets, inspectBlueprint } from '@/lib/blueprint';
import FlowEditor from './components/FlowEditor';

const LS_KEY = 'blueprint-runner-state-v1';
const EMPTY_BP = '{\n  "name": "New scenario",\n  "subflows": [{ "flow": [] }],\n  "metadata": { "version": 1 }\n}';

interface KV {
  key: string;
  value: string;
}

interface PersistedState {
  blueprintText: string;
  variables: KV[];
  connections: KV[];
}

function loadState(): PersistedState | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as PersistedState) : null;
  } catch {
    return null;
  }
}

function LogRow({ e }: { e: LogEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="log-entry">
      <div className="head" onClick={() => setOpen(!open)}>
        <span className={`status ${e.status}`} />
        <span className="name">
          [{e.moduleId}] {e.name}
        </span>
        {e.bundle ? <span className="badge">{e.bundle}</span> : null}
        <span className="summary">{e.summary ?? e.status}</span>
        {e.durationMs != null ? <span className="badge">{e.durationMs}ms</span> : null}
      </div>
      {e.error ? <div className="error-text">{e.error}</div> : null}
      {open && e.request !== undefined ? (
        <pre>{'REQUEST\n' + JSON.stringify(e.request, null, 2)}</pre>
      ) : null}
      {open && e.output !== undefined ? (
        <pre>{'OUTPUT\n' + JSON.stringify(e.output, null, 2)}</pre>
      ) : null}
    </div>
  );
}

function KVTable({
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  mask,
}: {
  rows: KV[];
  onChange: (rows: KV[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
  mask?: boolean;
}) {
  return (
    <table className="kv">
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td>
              <input
                type="text"
                value={r.key}
                placeholder={keyPlaceholder}
                onChange={(ev) => {
                  const next = [...rows];
                  next[i] = { ...r, key: ev.target.value };
                  onChange(next);
                }}
              />
            </td>
            <td>
              <input
                type={mask ? 'password' : 'text'}
                value={r.value}
                placeholder={valuePlaceholder}
                onChange={(ev) => {
                  const next = [...rows];
                  next[i] = { ...r, value: ev.target.value };
                  onChange(next);
                }}
              />
            </td>
            <td className="del">
              <button className="small" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                ✕
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function Home() {
  const [blueprintText, setBlueprintText] = useState('');
  const [tab, setTab] = useState<'visual' | 'json'>('visual');
  const [variables, setVariables] = useState<KV[]>([]);
  const [connections, setConnections] = useState<KV[]>([]);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [extractedNote, setExtractedNote] = useState<string | null>(null);
  const [loadedFromStorage, setLoadedFromStorage] = useState(false);

  useEffect(() => {
    const s = loadState();
    if (s) {
      setBlueprintText(s.blueprintText ?? '');
      setVariables(s.variables ?? []);
      setConnections(s.connections ?? []);
    }
    setLoadedFromStorage(true);
  }, []);

  useEffect(() => {
    if (!loadedFromStorage) return;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ blueprintText, variables, connections }));
    } catch {
      /* storage may be unavailable */
    }
  }, [blueprintText, variables, connections, loadedFromStorage]);

  const parsed = useMemo<{ bp: Blueprint | null; error: string | null }>(() => {
    if (!blueprintText.trim()) return { bp: null, error: null };
    try {
      const bp = JSON.parse(blueprintText) as Blueprint;
      if (!bp.flow && !bp.subflows) return { bp: null, error: 'JSON parsed, but no "flow" or "subflows" key found' };
      return { bp, error: null };
    } catch (e) {
      return { bp: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [blueprintText]);

  const info = useMemo(() => (parsed.bp ? inspectBlueprint(parsed.bp) : null), [parsed.bp]);

  // Ensure detected variables / connections have rows.
  useEffect(() => {
    if (!info) return;
    setVariables((cur) => {
      const have = new Set(cur.map((r) => r.key));
      const missing = info.variables.filter((v) => !have.has(v));
      return missing.length ? [...cur, ...missing.map((key) => ({ key, value: '' }))] : cur;
    });
    setConnections((cur) => {
      const have = new Set(cur.map((r) => r.key));
      const missing = info.connections.filter((c) => !have.has(c.id));
      return missing.length ? [...cur, ...missing.map((c) => ({ key: c.id, value: '' }))] : cur;
    });
  }, [info]);

  const applyBlueprint = useCallback((bp: Blueprint) => {
    setBlueprintText(JSON.stringify(bp, null, 2));
  }, []);

  const loadSample = useCallback(async () => {
    const res = await fetch('/samples/medical-records-sync.json');
    const text = await res.text();
    setBlueprintText(JSON.stringify(JSON.parse(text), null, 2));
    setResult(null);
  }, []);

  const doExtractSecrets = useCallback(() => {
    if (!parsed.bp) return;
    const { blueprint, secrets } = extractSecrets(parsed.bp);
    if (secrets.length === 0) {
      setExtractedNote('No hardcoded tokens found in HTTP headers.');
      return;
    }
    setBlueprintText(JSON.stringify(blueprint, null, 2));
    setVariables((cur) => {
      const next = [...cur];
      for (const s of secrets) {
        const existing = next.find((r) => r.key === s.variable);
        if (existing) existing.value = s.value;
        else next.push({ key: s.variable, value: s.value });
      }
      return next;
    });
    setExtractedNote(
      `Extracted ${secrets.length} secret(s) into variables (${secrets
        .map((s) => s.variable)
        .join(', ')}). The blueprint now references them as {{var.NAME}} — values are stored only in your browser.`,
    );
  }, [parsed.bp]);

  const run = useCallback(
    async (dryRun: boolean) => {
      if (!parsed.bp) return;
      setRunning(true);
      setResult(null);
      try {
        const res = await fetch('/api/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            blueprint: parsed.bp,
            dryRun,
            variables: Object.fromEntries(variables.filter((v) => v.key).map((v) => [v.key, v.value])),
            connections: Object.fromEntries(
              connections.filter((c) => c.key).map((c) => [c.key, { token: c.value }]),
            ),
          }),
        });
        const data = (await res.json()) as RunResult;
        setResult(data);
      } catch (e) {
        setResult({
          ok: false,
          ops: 0,
          durationMs: 0,
          log: [],
          error: e instanceof Error ? e.message : String(e),
        });
      } finally {
        setRunning(false);
      }
    },
    [parsed.bp, variables, connections],
  );

  return (
    <div className="app">
      <header className="top">
        <div className="logo">⚡</div>
        <div>
          <h1>Blueprint Runner</h1>
          <div className="sub">Self-hosted Make.com-style scenario builder &amp; runner</div>
        </div>
        <span style={{ flex: 1 }} />
        <div className="runbar" style={{ margin: 0 }}>
          <button className="primary" disabled={!parsed.bp || running} onClick={() => run(false)}>
            {running ? 'Running…' : '▶ Run scenario'}
          </button>
          <button disabled={!parsed.bp || running} onClick={() => run(true)}>
            Dry run
          </button>
        </div>
      </header>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="row" style={{ marginTop: 0, marginBottom: 10 }}>
          <div className="tabs">
            <button className={tab === 'visual' ? 'tab active' : 'tab'} onClick={() => setTab('visual')}>
              Visual editor
            </button>
            <button className={tab === 'json' ? 'tab active' : 'tab'} onClick={() => setTab('json')}>
              Blueprint JSON
            </button>
          </div>
          <span style={{ flex: 1 }} />
          <button className="small" onClick={loadSample}>
            Load sample scenario
          </button>
          <button className="small" onClick={() => setBlueprintText(EMPTY_BP)}>
            New empty scenario
          </button>
          <button className="small" onClick={doExtractSecrets} disabled={!parsed.bp}>
            Extract hardcoded tokens
          </button>
          {parsed.error ? <span className="badge" style={{ color: 'var(--err)' }}>⚠ {parsed.error}</span> : null}
          {info ? <span className="badge accent">{info.moduleCount} modules</span> : null}
        </div>

        {tab === 'visual' ? (
          parsed.bp ? (
            <FlowEditor blueprint={parsed.bp} onChange={applyBlueprint} />
          ) : (
            <div className="canvas-empty">
              <p>No scenario loaded yet.</p>
              <div className="row" style={{ justifyContent: 'center' }}>
                <button className="primary" onClick={() => setBlueprintText(EMPTY_BP)}>
                  Start a new scenario
                </button>
                <button onClick={loadSample}>Load the sample</button>
              </div>
              <p className="hint">…or switch to the JSON tab and paste a Make.com blueprint export.</p>
            </div>
          )
        ) : (
          <textarea
            className="code"
            style={{ minHeight: 420 }}
            spellCheck={false}
            value={blueprintText}
            placeholder='Paste a Make.com blueprint export here ({"subflows":[{"flow":[...]}]} or {"flow":[...]})'
            onChange={(e) => setBlueprintText(e.target.value)}
          />
        )}
        {extractedNote ? <div className="secret-note">{extractedNote}</div> : null}
      </div>

      <div className="grid">
        <div className="panel">
          <h2>
            Variables (tokens &amp; auth)
            <button className="small" onClick={() => setVariables([...variables, { key: '', value: '' }])}>
              + add
            </button>
          </h2>
          <KVTable rows={variables} onChange={setVariables} keyPlaceholder="NAME" valuePlaceholder="value / token" mask />
          <div className="hint">
            Reference in blueprints as <code>{'{{var.NAME}}'}</code>, e.g. <code>{'Bearer {{var.UNITE_API_TOKEN}}'}</code>.
            Stored in your browser; can also be set server-side as <code>BP_VAR_NAME</code> env vars.
          </div>
        </div>

        <div className="panel">
          <h2>
            Connections
            <button className="small" onClick={() => setConnections([...connections, { key: '', value: '' }])}>
              + add
            </button>
          </h2>
          <KVTable
            rows={connections}
            onChange={setConnections}
            keyPlaceholder="__IMTCONN__ id (e.g. 10209480)"
            valuePlaceholder="API token for this connection"
            mask
          />
          <div className="hint">
            Map each Make connection id to an API token (e.g. an Airtable personal access token). Server-side
            equivalent: <code>BP_CONN_&lt;id&gt;</code> env vars.
          </div>
        </div>
      </div>

      {result ? (
        <div className="panel" style={{ marginTop: 16 }}>
          <h2>
            Execution log ({result.log.length} entries — click a row for request/output)
            <span className="runstat">
              {result.ok ? <b className="ok">✓ finished</b> : <b className="err">✗ {result.error ?? 'failed'}</b>} ·{' '}
              {result.ops} ops · {result.durationMs}ms
            </span>
          </h2>
          <div className="log">
            {result.log.map((e) => (
              <LogRow key={e.seq} e={e} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
