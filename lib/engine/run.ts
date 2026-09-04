// Blueprint orchestrator: walks a Make.com blueprint's flow, handling
// iterators (feeders), routers, if/else branches, merges, aggregators,
// variables, and per-module filters, with per-bundle scoping.

import type {
  Blueprint,
  BlueprintModule,
  LogEntry,
  RunOptions,
  RunResult,
  Scope,
} from './types';
import { cloneScope } from './types';
import { evalConditions, passesFilter } from './conditions';
import { evalTemplate, toDisplayString } from './expressions';
import { execAirtable, execHttp, ModuleError, type ExecResult } from './modules';

const MAX_LOGGED_BYTES = 4096;

function truncateForLog(v: unknown): unknown {
  if (v === undefined) return undefined;
  try {
    const s = JSON.stringify(v);
    if (s && s.length > MAX_LOGGED_BYTES) {
      return { _truncated: true, preview: s.slice(0, MAX_LOGGED_BYTES) };
    }
    return v;
  } catch {
    return String(v).slice(0, MAX_LOGGED_BYTES);
  }
}

class Halt {
  constructor(public reason: string) {}
}

class Runner {
  private log: LogEntry[] = [];
  private seq = 0;
  private ops = 0;
  private readonly maxOps: number;
  private readonly deadline: number;

  constructor(private opts: RunOptions) {
    this.maxOps = opts.maxOps ?? 5000;
    this.deadline = Date.now() + 280_000; // stay under serverless limits
  }

  private addLog(entry: Omit<LogEntry, 'seq'>): void {
    if (this.log.length >= 2000) return;
    this.log.push({ seq: ++this.seq, ...entry });
  }

  private checkBudget(): void {
    if (this.ops >= this.maxOps) throw new ModuleError(`Operation cap reached (${this.maxOps})`);
    if (Date.now() > this.deadline) throw new ModuleError('Run time budget exceeded');
  }

  async run(blueprint: Blueprint): Promise<RunResult> {
    const started = Date.now();
    const flows: BlueprintModule[][] = blueprint.subflows?.length
      ? blueprint.subflows.map((s) => s.flow ?? [])
      : blueprint.flow
        ? [blueprint.flow]
        : [];
    if (flows.length === 0) {
      return { ok: false, ops: 0, durationMs: 0, log: [], error: 'Blueprint has no flow/subflows' };
    }
    const scope: Scope = {
      outputs: {},
      vars: {},
      variables: this.opts.variables ?? {},
      feeders: {},
    };
    let error: string | undefined;
    try {
      for (const flow of flows) {
        await this.runSequence(flow, 0, scope);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    return {
      ok: !error,
      ops: this.ops,
      durationMs: Date.now() - started,
      log: this.log,
      error,
    };
  }

  /** Execute modules from index i onward for the current bundle scope. */
  private async runSequence(flow: BlueprintModule[], i: number, scope: Scope): Promise<void> {
    if (i >= flow.length) return;
    const mod = flow[i];
    this.checkBudget();

    const name = mod.metadata?.designer?.name || mod.module;

    // Module-level filter gates execution of this module and everything after
    // it on this path.
    if (mod.filter && !passesFilter(mod.filter, scope)) {
      this.addLog({ moduleId: mod.id, module: mod.module, name, status: 'filtered', summary: `filter "${mod.filter.name || ''}" not met` });
      return;
    }

    const kind = mod.module;

    // ---- Flow-control modules -------------------------------------------
    if (kind === 'builtin:BasicFeeder' || kind === 'builtin:ArrayIterator' || kind === 'json:ParseJSON:iterator') {
      const raw = evalTemplate((mod.mapper as Record<string, unknown>)?.array, scope);
      const arr = normalizeArray(raw);
      this.ops++;
      this.addLog({ moduleId: mod.id, module: kind, name, status: 'ok', summary: `iterating ${arr.length} item(s)` });
      for (let idx = 0; idx < arr.length; idx++) {
        const item = arr[idx];
        const child = cloneScope(scope);
        const bundle =
          item && typeof item === 'object' && !Array.isArray(item)
            ? { ...(item as Record<string, unknown>), __IMTINDEX__: idx + 1, __IMTLENGTH__: arr.length }
            : { value: item, __IMTINDEX__: idx + 1, __IMTLENGTH__: arr.length };
        child.outputs[String(mod.id)] = bundle;
        child.feeders[String(mod.id)] = { array: arr, index: idx, length: arr.length };
        try {
          await this.runSequence(flow, i + 1, child);
        } catch (e) {
          if (e instanceof Halt) continue;
          // One bad item should not kill the whole run; log and continue.
          this.addLog({
            moduleId: mod.id,
            module: kind,
            name,
            status: 'error',
            bundle: `${idx + 1}/${arr.length}`,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      return;
    }

    if (kind === 'builtin:BasicRouter') {
      this.ops++;
      for (const route of mod.routes ?? []) {
        const child = cloneScope(scope);
        try {
          await this.runSequence(route.flow ?? [], 0, child);
        } catch (e) {
          if (!(e instanceof Halt)) {
            this.addLog({
              moduleId: mod.id,
              module: kind,
              name,
              status: 'error',
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }
      return this.runSequence(flow, i + 1, scope);
    }

    if (kind === 'builtin:BasicIfElse') {
      this.ops++;
      const branches = (mod.branches ?? []).filter((b) => !b.disabled);
      let taken = false;
      for (const branch of branches) {
        const matches =
          branch.type === 'else' ? true : evalConditions(branch.conditions, scope);
        if (!matches) continue;
        taken = true;
        this.addLog({
          moduleId: mod.id,
          module: kind,
          name,
          status: 'ok',
          summary: `branch: ${branch.label || branch.type}`,
        });
        // Branch runs in the SAME scope so its outputs are visible after the
        // merge point (merge: true).
        await this.runSequence(branch.flow ?? [], 0, scope);
        break;
      }
      if (!taken) {
        this.addLog({ moduleId: mod.id, module: kind, name, status: 'skipped', summary: 'no branch matched' });
      }
      return this.runSequence(flow, i + 1, scope);
    }

    if (kind === 'builtin:BasicMerge' || kind === 'builtin:BasicAggregator') {
      // Pass-through; its filter (already applied above) is the gate.
      this.ops++;
      this.addLog({ moduleId: mod.id, module: kind, name, status: 'ok' });
      return this.runSequence(flow, i + 1, scope);
    }

    if (kind === 'placeholder:Placeholder' || kind.startsWith('placeholder:')) {
      return this.runSequence(flow, i + 1, scope);
    }

    if (kind === 'util:TextAggregator') {
      const feederId = String((mod.parameters as Record<string, unknown>)?.feeder ?? '');
      const st = scope.feeders[feederId];
      this.ops++;
      if (st && st.index < st.length - 1) {
        // Only the last bundle of the source iterator flows onward.
        throw new Halt('aggregator waiting for last bundle');
      }
      const template = (mod.mapper as Record<string, unknown>)?.value;
      const sepParam = (mod.parameters as Record<string, unknown>) ?? {};
      const sep =
        sepParam.rowSeparator === 'other'
          ? toDisplayString(sepParam.otherRowSeparator)
          : sepParam.rowSeparator === 'tab'
            ? '\t'
            : sepParam.rowSeparator === 'comma'
              ? ','
              : '\n';
      let text: string;
      if (st) {
        const parts: string[] = [];
        for (const item of st.array) {
          const tmp = cloneScope(scope);
          tmp.outputs[feederId] =
            item && typeof item === 'object' && !Array.isArray(item) ? item : { value: item };
          parts.push(toDisplayString(evalTemplate(template, tmp)));
        }
        text = parts.filter((p) => p !== '').join(sep);
      } else {
        text = toDisplayString(evalTemplate(template, scope));
      }
      scope.outputs[String(mod.id)] = { text };
      this.addLog({ moduleId: mod.id, module: kind, name, status: 'ok', output: truncateForLog({ text }) });
      return this.runSequence(flow, i + 1, scope);
    }

    if (kind === 'util:SetVariable2' || kind === 'util:SetVariable') {
      this.ops++;
      const m = (mod.mapper ?? {}) as Record<string, unknown>;
      const varName = toDisplayString(evalTemplate(m.name, scope));
      const value = evalTemplate(m.value, scope);
      scope.vars[varName] = value;
      scope.outputs[String(mod.id)] = { [varName]: value };
      this.addLog({ moduleId: mod.id, module: kind, name, status: 'ok', output: truncateForLog({ [varName]: value }) });
      return this.runSequence(flow, i + 1, scope);
    }

    if (kind === 'util:SetVariables') {
      this.ops++;
      const m = (mod.mapper ?? {}) as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const v of (m.variables as Array<Record<string, unknown>>) ?? []) {
        const varName = toDisplayString(evalTemplate(v.name, scope));
        const value = evalTemplate(v.value, scope);
        scope.vars[varName] = value;
        out[varName] = value;
      }
      scope.outputs[String(mod.id)] = out;
      this.addLog({ moduleId: mod.id, module: kind, name, status: 'ok', output: truncateForLog(out) });
      return this.runSequence(flow, i + 1, scope);
    }

    if (kind === 'util:GetVariables' || kind === 'util:GetVariable2' || kind === 'util:GetVariable') {
      this.ops++;
      const m = (mod.mapper ?? {}) as Record<string, unknown>;
      const names: string[] = Array.isArray(m.variables)
        ? (m.variables as unknown[]).map((v) => toDisplayString(v))
        : m.name
          ? [toDisplayString(m.name)]
          : [];
      const out: Record<string, unknown> = {};
      for (const n of names) out[n] = scope.vars[n];
      scope.outputs[String(mod.id)] = out;
      this.addLog({ moduleId: mod.id, module: kind, name, status: 'ok', output: truncateForLog(out) });
      return this.runSequence(flow, i + 1, scope);
    }

    if (kind === 'builtin:BasicSleep' || kind === 'util:Sleep') {
      const delay = Math.min(Number(evalTemplate((mod.mapper as Record<string, unknown>)?.delay, scope)) || 1, 10);
      await new Promise((r) => setTimeout(r, delay * 1000));
      this.ops++;
      this.addLog({ moduleId: mod.id, module: kind, name, status: 'ok', summary: `slept ${delay}s` });
      return this.runSequence(flow, i + 1, scope);
    }

    if (kind === 'json:ParseJSON') {
      this.ops++;
      const raw = toDisplayString(evalTemplate((mod.mapper as Record<string, unknown>)?.json, scope));
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        throw new ModuleError(`ParseJSON failed: ${e instanceof Error ? e.message : e}`);
      }
      scope.outputs[String(mod.id)] = parsed;
      this.addLog({ moduleId: mod.id, module: kind, name, status: 'ok', output: truncateForLog(parsed) });
      return this.runSequence(flow, i + 1, scope);
    }

    if (kind === 'util:ComposeTransformer' || kind === 'util:FunctionText') {
      this.ops++;
      const value = evalTemplate((mod.mapper as Record<string, unknown>)?.value, scope);
      scope.outputs[String(mod.id)] = { value };
      this.addLog({ moduleId: mod.id, module: kind, name, status: 'ok', output: truncateForLog({ value }) });
      return this.runSequence(flow, i + 1, scope);
    }

    // ---- External-call modules ------------------------------------------
    const started = Date.now();
    let result: ExecResult;
    try {
      this.ops++;
      if (kind.startsWith('http:')) {
        result = await execHttp(mod, scope, this.opts);
      } else if (kind.startsWith('airtable:')) {
        result = await execAirtable(mod, scope, this.opts);
      } else {
        // Unknown app module: log and continue with an empty bundle so the
        // rest of the flow can still be exercised.
        this.addLog({
          moduleId: mod.id,
          module: kind,
          name,
          status: 'skipped',
          summary: `unsupported module type — emitted empty bundle`,
        });
        scope.outputs[String(mod.id)] = {};
        return this.runSequence(flow, i + 1, scope);
      }
    } catch (e) {
      this.addLog({
        moduleId: mod.id,
        module: kind,
        name,
        status: 'error',
        durationMs: Date.now() - started,
        error: e instanceof Error ? e.message : String(e),
        request: e instanceof ModuleError ? truncateForLog(e.details) : undefined,
      });
      throw e;
    }

    const durationMs = Date.now() - started;
    if (result.bundles.length === 1) {
      scope.outputs[String(mod.id)] = result.bundles[0];
      this.addLog({
        moduleId: mod.id,
        module: kind,
        name,
        status: result.dryRun ? 'dry-run' : 'ok',
        summary: result.summary,
        request: truncateForLog(result.request),
        output: truncateForLog(result.bundles[0]),
        durationMs,
      });
      return this.runSequence(flow, i + 1, scope);
    }

    // Multi-bundle output (e.g. search): iterate downstream per bundle.
    this.addLog({
      moduleId: mod.id,
      module: kind,
      name,
      status: result.dryRun ? 'dry-run' : 'ok',
      summary: result.summary,
      request: truncateForLog(result.request),
      durationMs,
    });
    for (let b = 0; b < result.bundles.length; b++) {
      const child = cloneScope(scope);
      child.outputs[String(mod.id)] = result.bundles[b];
      child.feeders[String(mod.id)] = { array: result.bundles, index: b, length: result.bundles.length };
      try {
        await this.runSequence(flow, i + 1, child);
      } catch (e) {
        if (e instanceof Halt) continue;
        this.addLog({
          moduleId: mod.id,
          module: kind,
          name,
          status: 'error',
          bundle: `${b + 1}/${result.bundles.length}`,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
}

function normalizeArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw === undefined || raw === null || raw === '') return [];
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : [p];
    } catch {
      return [raw];
    }
  }
  return [raw];
}

export async function runBlueprint(blueprint: Blueprint, opts: RunOptions = {}): Promise<RunResult> {
  return new Runner(opts).run(blueprint);
}
