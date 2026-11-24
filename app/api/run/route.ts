import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { runBlueprint } from '@/lib/engine';
import type { Blueprint, RunOptions } from '@/lib/engine';

export const runtime = 'nodejs';
export const maxDuration = 300; // allow long scenario runs on Vercel
export const dynamic = 'force-dynamic';

interface RunRequest {
  blueprint: Blueprint;
  variables?: Record<string, string>;
  connections?: Record<string, { type?: string; token?: string }>;
  dryRun?: boolean;
  maxOps?: number;
}

/**
 * Server-side secret fallbacks from environment variables (set them in
 * Vercel → Project → Settings → Environment Variables):
 *   BP_VAR_<NAME>   -> blueprint variable {{var.NAME}}
 *   BP_CONN_<id>    -> token for Make connection __IMTCONN__ <id>
 * Values sent by the client override these.
 */
function envDefaults(): {
  variables: Record<string, string>;
  connections: Record<string, { token: string }>;
} {
  const variables: Record<string, string> = {};
  const connections: Record<string, { token: string }> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue;
    if (k.startsWith('BP_VAR_')) variables[k.slice('BP_VAR_'.length)] = v;
    else if (k.startsWith('BP_CONN_')) connections[k.slice('BP_CONN_'.length)] = { token: v };
  }
  return { variables, connections };
}

function fail(status: number, error: string) {
  return NextResponse.json({ ok: false, ops: 0, durationMs: 0, log: [], error }, { status });
}

/**
 * Who may make live calls from this server.
 * - Dry runs make no network calls, so anyone may run them.
 * - Live runs need RUN_ACCESS_KEY to be set and sent as the x-run-key header,
 *   except under `next dev`. Without this, a public deployment would let
 *   anyone use the server to send HTTP requests.
 */
function liveRunAllowed(req: NextRequest): boolean {
  if (process.env.NODE_ENV === 'development') return true;
  const key = process.env.RUN_ACCESS_KEY;
  if (!key) return false;
  const sent = req.headers.get('x-run-key') ?? '';
  const a = Buffer.from(sent);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  let body: RunRequest;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'Invalid JSON body');
  }
  if (!body?.blueprint || (!body.blueprint.flow && !body.blueprint.subflows)) {
    return fail(400, 'Missing blueprint (expected { flow: [...] } or { subflows: [...] })');
  }

  const dryRun = body.dryRun === true;
  const authorised = liveRunAllowed(req);
  if (!dryRun && !authorised) {
    return fail(
      403,
      process.env.RUN_ACCESS_KEY
        ? 'Live runs need the run key. Enter it under Run key, or use Dry run.'
        : 'Live runs are switched off on this deployment. Use Dry run, or self-host it and set RUN_ACCESS_KEY.',
    );
  }

  // Server-side secrets only ever go to runs that passed the key check, so a
  // stranger's blueprint (dry runs included) can't read them back in the log.
  const env = authorised ? envDefaults() : { variables: {}, connections: {} };
  const clientVars = Object.fromEntries(
    Object.entries(body.variables ?? {}).filter(([, v]) => v !== undefined && v !== ''),
  );
  const clientConns = Object.fromEntries(
    Object.entries(body.connections ?? {}).filter(([, c]) => c?.token),
  );
  const opts: RunOptions = {
    variables: { ...env.variables, ...clientVars },
    connections: { ...env.connections, ...clientConns },
    dryRun,
    maxOps: Math.min(Math.max(Number(body.maxOps) || 5000, 1), 20000),
    blockPrivateNetwork: process.env.ALLOW_PRIVATE_NETWORK !== '1',
  };
  const result = await runBlueprint(body.blueprint, opts);
  return NextResponse.json(result);
}
