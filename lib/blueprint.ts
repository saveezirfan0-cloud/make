// Blueprint introspection helpers shared by UI and API:
// - detect {{var.X}} variables and __IMTCONN__ connection ids
// - extract hardcoded secrets (Bearer tokens, api keys) into variables

import type { Blueprint, BlueprintModule } from './engine/types';

export interface BlueprintInfo {
  moduleCount: number;
  variables: string[]; // {{var.X}} names referenced
  connections: { id: string; app: string; label?: string }[];
  apps: string[];
}

function walkModules(bp: Blueprint, fn: (m: BlueprintModule) => void): void {
  const visit = (mods?: BlueprintModule[]) => {
    for (const m of mods ?? []) {
      fn(m);
      for (const r of m.routes ?? []) visit(r.flow);
      for (const b of m.branches ?? []) visit(b.flow);
    }
  };
  if (bp.subflows) for (const s of bp.subflows) visit(s.flow);
  visit(bp.flow);
}

export function inspectBlueprint(bp: Blueprint): BlueprintInfo {
  let moduleCount = 0;
  const variables = new Set<string>();
  const connections = new Map<string, { id: string; app: string; label?: string }>();
  const apps = new Set<string>();

  walkModules(bp, (m) => {
    moduleCount++;
    apps.add(m.module.split(':')[0]);
    const conn = m.parameters?.__IMTCONN__;
    if (conn != null) {
      const id = String(conn);
      const restore = (m.metadata as Record<string, any> | undefined)?.restore?.parameters?.__IMTCONN__;
      if (!connections.has(id)) {
        connections.set(id, { id, app: m.module.split(':')[0], label: restore?.label });
      }
    }
    const json = JSON.stringify([m.mapper, m.filter, m.branches?.map((b) => b.conditions)]);
    for (const match of json?.matchAll(/\{\{\s*var\.([A-Za-z0-9_]+)/g) ?? []) {
      variables.add(match[1]);
    }
  });

  return {
    moduleCount,
    variables: [...variables].sort(),
    connections: [...connections.values()],
    apps: [...apps].sort(),
  };
}

export interface ExtractedSecret {
  variable: string;
  value: string;
  where: string;
}

/**
 * Replace hardcoded bearer tokens / API keys found in HTTP headers and query
 * strings with {{var.X}} references. Returns the rewritten blueprint plus the
 * extracted values, so they can be stored as variables instead of in the JSON.
 */
export function extractSecrets(bp: Blueprint): { blueprint: Blueprint; secrets: ExtractedSecret[] } {
  const secrets: ExtractedSecret[] = [];
  const clone: Blueprint = JSON.parse(JSON.stringify(bp));
  let n = 0;

  walkModules(clone, (m) => {
    const mapper = m.mapper as Record<string, unknown> | null | undefined;
    if (!mapper) return;
    const lists = [mapper.headers, mapper.qs].filter(Array.isArray) as Array<Array<Record<string, unknown>>>;
    for (const list of lists) {
      for (const item of list) {
        const key = String(item.name ?? item.key ?? '');
        const value = String(item.value ?? '');
        if (!value || value.includes('{{')) continue;
        const isAuthHeader = /^(authorization|x-api-key|api[-_]?key|apikey|token|x-auth-token)$/i.test(key);
        const bearer = value.match(/^Bearer\s+(\S{20,})$/i);
        if (isAuthHeader && bearer) {
          n++;
          const variable = `TOKEN_${n}`;
          secrets.push({ variable, value: bearer[1], where: `module ${m.id} header "${key}"` });
          item.value = `Bearer {{var.${variable}}}`;
        } else if (isAuthHeader && value.length >= 16) {
          n++;
          const variable = `TOKEN_${n}`;
          secrets.push({ variable, value, where: `module ${m.id} header "${key}"` });
          item.value = `{{var.${variable}}}`;
        }
      }
    }
  });

  return { blueprint: clone, secrets };
}
