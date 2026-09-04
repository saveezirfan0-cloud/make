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
  const opts: RunOptions = {
    variables: body.variables ?? {},
    connections: body.connections ?? {},
    dryRun: body.dryRun === true,
    maxOps: Math.min(Math.max(Number(body.maxOps) || 5000, 1), 20000),
  };
  const result = await runBlueprint(body.blueprint, opts);
  return NextResponse.json(result);
}
