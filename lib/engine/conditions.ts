// Make.com filter condition evaluation.
// `conditions` is an OR-of-AND-groups matrix: [[a AND b], [c]] => (a&&b) || c

import type { FilterConditions, FilterSpec, Scope } from './types';
import { evalTemplate, isEmptyValue, toDisplayString } from './expressions';

function num(v: unknown): number {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function evalCondition(a: unknown, b: unknown, op: string): boolean {
  switch (op) {
    case 'exist':
      return !isEmptyValue(a);
    case 'notexist':
      return isEmptyValue(a);
    case 'text:equal':
      return toDisplayString(a) === toDisplayString(b);
    case 'text:equal:ci':
      return toDisplayString(a).toLowerCase() === toDisplayString(b).toLowerCase();
    case 'text:notequal':
      return toDisplayString(a) !== toDisplayString(b);
    case 'text:notequal:ci':
      return toDisplayString(a).toLowerCase() !== toDisplayString(b).toLowerCase();
    case 'text:contain':
      return toDisplayString(a).includes(toDisplayString(b));
    case 'text:contain:ci':
      return toDisplayString(a).toLowerCase().includes(toDisplayString(b).toLowerCase());
    case 'text:notcontain':
      return !toDisplayString(a).includes(toDisplayString(b));
    case 'text:notcontain:ci':
      return !toDisplayString(a).toLowerCase().includes(toDisplayString(b).toLowerCase());
    case 'text:startwith':
      return toDisplayString(a).startsWith(toDisplayString(b));
    case 'text:endwith':
      return toDisplayString(a).endsWith(toDisplayString(b));
    case 'number:equal':
      return num(a) === num(b);
    case 'number:notequal':
      return num(a) !== num(b);
    case 'number:greater':
      return num(a) > num(b);
    case 'number:greaterorequal':
      return num(a) >= num(b);
    case 'number:less':
      return num(a) < num(b);
    case 'number:lessorequal':
      return num(a) <= num(b);
    case 'boolean:equal':
      return String(a) === String(b);
    case 'array:contain':
      return Array.isArray(a) && a.some((x) => toDisplayString(x) === toDisplayString(b));
    case 'array:notcontain':
      return !Array.isArray(a) || !a.some((x) => toDisplayString(x) === toDisplayString(b));
    case 'date:equal':
      return toDisplayString(a) === toDisplayString(b);
    default:
      // Unknown operator: loose equality keeps flows moving.
      return toDisplayString(a) === toDisplayString(b);
  }
}

export function evalConditions(conditions: FilterConditions | undefined, scope: Scope): boolean {
  if (!conditions || conditions.length === 0) return true;
  return conditions.some((andGroup) => {
    if (!andGroup || andGroup.length === 0) return true;
    return andGroup.every((c) => {
      const a = c.a !== undefined ? evalTemplate(c.a, scope) : undefined;
      const b = c.b !== undefined ? evalTemplate(c.b, scope) : undefined;
      return evalCondition(a, b, c.o);
    });
  });
}

export function passesFilter(filter: FilterSpec | null | undefined, scope: Scope): boolean {
  if (!filter) return true;
  return evalConditions(filter.conditions, scope);
}
