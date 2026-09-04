'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Blueprint, BlueprintModule, LogEntry, RunResult } from '@/lib/engine/types';
import { extractSecrets, inspectBlueprint } from '@/lib/blueprint';

const LS_KEY = 'blueprint-runner-state-v1';

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

function ModuleTree({ modules, depth = 0 }: { modules: BlueprintModule[]; depth?: number }) {
  return (
    <>
      {modules.map((m, i) => {
        const app = m.module.split(':')[0];
        const cls =
          app === 'http'
            ? 'app-http'
            : app === 'airtable'
              ? 'app-airtable'
              : app === 'builtin'
                ? 'app-builtin'
                : app === 'util'
                  ? 'app-util'
                  : 'app-other';
        const label = m.metadata?.designer?.name;
        return (
          <div key={`${m.id}-${i}`}>
            <div className="mod" style={{ paddingLeft: depth * 16 }}>
              <span className="mid">[{m.id}]</span> <span className={cls}>{m.module}</span>
              {label ? <span className="mid"> — {label}</span> : null}
              {m.filter ? <span className="mid"> ⛉ filter</span> : null}
            </div>
            {(m.branches ?? []).map((b, bi) => (
              <div key={bi}>
                <div className="mod mid" style={{ paddingLeft: (depth + 1) * 16 }}>
                  ↳ {b.type === 'else' ? 'else' : `if ${b.label || `branch ${bi + 1}`}`}
                </div>
                <ModuleTree modules={b.flow ?? []} depth={depth + 2} />
              </div>
            ))}
            {(m.routes ?? []).map((r, ri) => (
              <div key={ri}>
                <div className="mod mid" style={{ paddingLeft: (depth + 1) * 16 }}>
                  ↳ route {ri + 1}
                </div>
                <ModuleTree modules={r.flow ?? []} depth={depth + 2} />
              </div>
            ))}
          </div>
        );
      })}
    </>
  );
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

  const topFlow = parsed.bp?.subflows?.[0]?.flow ?? parsed.bp?.flow ?? [];

  return (
    <div className="app">
      <header className="top">
        <div className="logo">⚡</div>
        <div>
          <h1>Blueprint Runner</h1>
          <div className="sub">Self-hosted Make.com-style scenario runner — paste a blueprint, set tokens as variables, run it</div>
        </div>
      </header>

      <div className="grid">
        <div>
          <div className="panel">
            <h2>
              Blueprint JSON
              <span>
                <button className="small" onClick={loadSample}>
                  Load sample scenario
                </button>
              </span>
            </h2>
            <textarea
              className="code"
              spellCheck={false}
              value={blueprintText}
              placeholder='Paste a Make.com blueprint export here ({"subflows":[{"flow":[...]}]} or {"flow":[...]})'
              onChange={(e) => setBlueprintText(e.target.value)}
            />
            <div className="row">
              <button onClick={doExtractSecrets} disabled={!parsed.bp}>
                Extract hardcoded tokens → variables
              </button>
              {parsed.error ? <span className="badge" style={{ color: 'var(--err)' }}>⚠ {parsed.error}</span> : null}
              {info ? (
                <>
                  <span className="badge accent">{info.moduleCount} modules</span>
                  {info.apps.map((a) => (
                    <span key={a} className="badge">
                      {a}
                    </span>
                  ))}
                </>
              ) : null}
            </div>
            {extractedNote ? <div className="secret-note">{extractedNote}</div> : null}
          </div>

          {topFlow.length > 0 ? (
            <div className="panel" style={{ marginTop: 16 }}>
              <h2>Scenario structure</h2>
              <div className="tree">
                <ModuleTree modules={topFlow} />
              </div>
            </div>
          ) : null}
        </div>

        <div>
          <div className="panel">
            <h2>
              Variables (tokens &amp; auth)
              <button className="small" onClick={() => setVariables([...variables, { key: '', value: '' }])}>
                + add
              </button>
            </h2>
            <KVTable
              rows={variables}
              onChange={setVariables}
              keyPlaceholder="NAME"
              valuePlaceholder="value / token"
              mask
            />
            <div className="hint">
              Reference in blueprints as <code>{'{{var.NAME}}'}</code>, e.g. header value{' '}
              <code>{'Bearer {{var.UNITE_API_TOKEN}}'}</code>. Values live in your browser&apos;s localStorage and are
              sent only to your own <code>/api/run</code> endpoint at execution time.
            </div>
          </div>

          <div className="panel" style={{ marginTop: 16 }}>
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
              Make blueprints reference named connections by numeric id (<code>__IMTCONN__</code>). Map each id to an
              API token here — e.g. an Airtable personal access token with <code>data.records:read/write</code> scopes.
              A variable named <code>AIRTABLE_TOKEN</code> works as a fallback for all Airtable modules.
            </div>
          </div>

          <div className="runbar">
            <button className="primary" disabled={!parsed.bp || running} onClick={() => run(false)}>
              {running ? 'Running…' : '▶ Run scenario'}
            </button>
            <button disabled={!parsed.bp || running} onClick={() => run(true)}>
              Dry run (no external calls)
            </button>
            {result ? (
              <span className="runstat">
                {result.ok ? <b className="ok">✓ finished</b> : <b className="err">✗ {result.error ?? 'failed'}</b>} ·{' '}
                {result.ops} ops · {result.durationMs}ms
              </span>
            ) : null}
          </div>

          {result ? (
            <div className="panel">
              <h2>Execution log ({result.log.length} entries — click a row for request/output)</h2>
              <div className="log">
                {result.log.map((e) => (
                  <LogRow key={e.seq} e={e} />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
