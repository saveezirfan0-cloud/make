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

export async function POST(req: NextRequest) {
  let body: RunRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body?.blueprint || (!body.blueprint.flow && !body.blueprint.subflows)) {
    return NextResponse.json(
      { ok: false, error: 'Missing blueprint (expected { flow: [...] } or { subflows: [...] })' },
      { status: 400 },
    );
  }
  const env = envDefaults();
  const clientVars = Object.fromEntries(
    Object.entries(body.variables ?? {}).filter(([, v]) => v !== undefined && v !== ''),
  );
  const clientConns = Object.fromEntries(
    Object.entries(body.connections ?? {}).filter(([, c]) => c?.token),
  );
  const opts: RunOptions = {
    variables: { ...env.variables, ...clientVars },
    connections: { ...env.connections, ...clientConns },
    dryRun: body.dryRun === true,
    maxOps: Math.min(Math.max(Number(body.maxOps) || 5000, 1), 20000),
  };
  const result = await runBlueprint(body.blueprint, opts);
  return NextResponse.json(result);
}
