// Evaluator for Make.com-style {{ }} mapping expressions.
//
// Supports:
//   {{3.data.Data}}                      module output references
//   {{5.notes.`Doctor Notes`}}           backtick-quoted keys
//   {{5.vitals[].Height}}                array mapping (joined with ", ")
//   {{4.visitdetails}}                   raw values (arrays/objects preserved
//                                        when the template is a single expression)
//   {{formatDate(5.visitdate; "MM/DD/YYYY")}}   functions, ';'-separated args
//   {{ifempty(6.id; 134.pid)}}
//   {{replace(toString(x); ","; "\",\"")}}
//   {{"\",\"" + space}}                  string concatenation, keywords
//   {{var.MY_TOKEN}}                     user variables (tokens, auth secrets)

import type { Scope } from './types';

// ---------------------------------------------------------------------------
// Tokenizer

type Token =
  | { t: 'str'; v: string }
  | { t: 'num'; v: number }
  | { t: 'ident'; v: string }
  | { t: 'backtick'; v: string }
  | { t: 'punct'; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      let s = '';
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) {
          const n = src[i + 1];
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          i += 2;
        } else {
          s += src[i++];
        }
      }
      i++; // closing quote
      out.push({ t: 'str', v: s });
      continue;
    }
    if (c === '`') {
      i++;
      let s = '';
      while (i < src.length && src[i] !== '`') s += src[i++];
      i++;
      out.push({ t: 'backtick', v: s });
      continue;
    }
    if (c >= '0' && c <= '9') {
      let s = '';
      while (i < src.length && src[i] >= '0' && src[i] <= '9') s += src[i++];
      // Do NOT consume '.' — "3.data" is a path, and float literals are rare
      // in blueprints. Handle "1.5" only when followed by digits then non-ident.
      if (
        src[i] === '.' &&
        src[i + 1] >= '0' &&
        src[i + 1] <= '9'
      ) {
        // lookahead: digits followed by identifier char => path like 3.0abc (unlikely); treat as float
        let j = i + 1;
        let frac = '';
        while (j < src.length && src[j] >= '0' && src[j] <= '9') frac += src[j++];
        const nxt = src[j];
        if (!(nxt && /[A-Za-z_`]/.test(nxt))) {
          i = j;
          out.push({ t: 'num', v: parseFloat(`${s}.${frac}`) });
          continue;
        }
      }
      out.push({ t: 'num', v: parseInt(s, 10) });
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let s = '';
      while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) s += src[i++];
      out.push({ t: 'ident', v: s });
      continue;
    }
    if ('().;[]+-*/'.includes(c)) {
      out.push({ t: 'punct', v: c });
      i++;
      continue;
    }
    // Unknown char: skip defensively
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parser / evaluator

class ExprEval {
  private toks: Token[];
  private pos = 0;
  constructor(src: string, private scope: Scope) {
    this.toks = tokenize(src);
  }

  private peek(): Token | undefined {
    return this.toks[this.pos];
  }
  private next(): Token | undefined {
    return this.toks[this.pos++];
  }
  private isPunct(v: string): boolean {
    const t = this.peek();
    return !!t && t.t === 'punct' && t.v === v;
  }

  evaluate(): unknown {
    if (this.toks.length === 0) return undefined;
    const v = this.parseExpr();
    return v;
  }

  private parseExpr(): unknown {
    let left = this.parseTerm();
    while (this.isPunct('+') || this.isPunct('-') || this.isPunct('*') || this.isPunct('/')) {
      const op = (this.next() as Token & { v: string }).v;
      const right = this.parseTerm();
      if (op === '+') {
        if (typeof left === 'number' && typeof right === 'number') left = left + right;
        else left = toDisplayString(left) + toDisplayString(right);
      } else {
        const l = Number(left);
        const r = Number(right);
        left = op === '-' ? l - r : op === '*' ? l * r : r === 0 ? null : l / r;
      }
    }
    return left;
  }

  private parseTerm(): unknown {
    const t = this.peek();
    if (!t) return undefined;
    if (t.t === 'str') {
      this.next();
      return t.v;
    }
    if (t.t === 'punct' && t.v === '(') {
      this.next();
      const v = this.parseExpr();
      if (this.isPunct(')')) this.next();
      return v;
    }
    if (t.t === 'num') {
      this.next();
      // module output reference: NUM '.' path
      if (this.isPunct('.') || this.isPunct('[')) {
        const root = this.scope.outputs[String(t.v)];
        return this.parsePath(root);
      }
      // bare module reference {{5}} -> whole output bundle
      if (this.scope.outputs[String(t.v)] !== undefined && this.toks.length === 1) {
        return this.scope.outputs[String(t.v)];
      }
      return t.v;
    }
    if (t.t === 'ident') {
      this.next();
      const name = t.v;
      // function call
      if (this.isPunct('(')) {
        this.next(); // '('
        const args: unknown[] = [];
        if (!this.isPunct(')')) {
          args.push(this.parseExpr());
          while (this.isPunct(';')) {
            this.next();
            args.push(this.parseExpr());
          }
        }
        if (this.isPunct(')')) this.next();
        let value = callFunction(name, args);
        if (this.isPunct('.') || this.isPunct('[')) value = this.parsePath(value);
        return value;
      }
      // keywords
      switch (name) {
        case 'space':
          return ' ';
        case 'newline':
          return '\n';
        case 'tab':
          return '\t';
        case 'emptystring':
          return '';
        case 'true':
          return true;
        case 'false':
          return false;
        case 'null':
          return null;
        case 'timestamp':
          return Math.floor(Date.now() / 1000);
        case 'now':
          if (!this.isPunct('(')) return new Date().toISOString();
          break;
      }
      // {{var.NAME}} -> user variable
      if (name === 'var' && this.isPunct('.')) {
        this.next();
        const key = this.next();
        if (key && (key.t === 'ident' || key.t === 'backtick')) {
          const val = this.scope.variables[key.v];
          return this.parsePathTail(val);
        }
        return undefined;
      }
      // Unknown bare identifier: try user variable, then treat as literal text
      if (this.scope.variables[name] !== undefined) {
        return this.parsePathTail(this.scope.variables[name]);
      }
      return name;
    }
    // stray punct
    this.next();
    return undefined;
  }

  /** Continue resolving `.key`, `[n]`, `[]` after a base value. */
  private parsePath(base: unknown): unknown {
    return this.parsePathTail(base);
  }

  private parsePathTail(base: unknown): unknown {
    let cur: unknown = base;
    while (true) {
      if (this.isPunct('.')) {
        this.next();
        const key = this.next();
        if (!key) break;
        const k = key.t === 'backtick' || key.t === 'ident' ? String(key.v) : String((key as { v: unknown }).v);
        cur = getProp(cur, k);
        continue;
      }
      if (this.isPunct('[')) {
        this.next();
        if (this.isPunct(']')) {
          // `[]` array mapping: map remaining path over elements, join ", "
          this.next();
          const arr = Array.isArray(cur) ? cur : cur == null ? [] : [cur];
          // Snapshot remaining tokens; apply to each element
          const restStart = this.pos;
          let restEnd = restStart;
          const results: unknown[] = [];
          for (const el of arr) {
            this.pos = restStart;
            results.push(this.parsePathTail(el));
            restEnd = this.pos;
          }
          this.pos = arr.length > 0 ? restEnd : this.skipPathTokens(restStart);
          const flat = results.filter((v) => v !== undefined && v !== null);
          if (flat.length === 0) return undefined;
          if (flat.length === 1) return flat[0];
          return flat.map(toDisplayString).join(', ');
        }
        const idxTok = this.next();
        if (this.isPunct(']')) this.next();
        if (idxTok && idxTok.t === 'num') {
          // Make is 1-indexed
          const arr = Array.isArray(cur) ? cur : [];
          cur = arr[(idxTok.v as number) - 1];
        }
        continue;
      }
      break;
    }
    return cur;
  }

  /** Advance past a path (`.x`, `` .`y` ``, `[n]`) without evaluating. */
  private skipPathTokens(from: number): number {
    this.pos = from;
    while (true) {
      if (this.isPunct('.')) {
        this.next();
        this.next();
        continue;
      }
      if (this.isPunct('[')) {
        this.next();
        if (!this.isPunct(']')) this.next();
        if (this.isPunct(']')) this.next();
        continue;
      }
      break;
    }
    return this.pos;
  }
}

function getProp(obj: unknown, key: string): unknown {
  if (obj == null) return undefined;
  if (Array.isArray(obj)) {
    // Property access on an array: Make often maps over the first element
    const first = obj[0];
    if (first != null && typeof first === 'object') {
      return (first as Record<string, unknown>)[key];
    }
    return undefined;
  }
  if (typeof obj === 'object') {
    const rec = obj as Record<string, unknown>;
    if (key in rec) return rec[key];
    // case-insensitive fallback (APIs are inconsistent about casing)
    const found = Object.keys(rec).find((k) => k.toLowerCase() === key.toLowerCase());
    return found !== undefined ? rec[found] : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Built-in functions

export function isEmptyValue(v: unknown): boolean {
  return (
    v === undefined ||
    v === null ||
    v === '' ||
    (Array.isArray(v) && v.length === 0)
  );
}

function parseDateFlexible(v: unknown): Date | null {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') return new Date(v > 1e12 ? v : v * 1000);
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = v.trim();
  // DD-MM-YYYY or DD/MM/YYYY
  let m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const d = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const y = parseInt(m[3], 10);
    // Disambiguate: if first component > 12 it must be the day; otherwise
    // prefer DD-MM for '-' separator (common in the Gulf-region APIs this
    // targets) and MM/DD for '/'.
    const sep = s.includes('/') ? '/' : '-';
    let day = d;
    let month = mo;
    if (d <= 12 && sep === '/') {
      month = d;
      day = mo;
    }
    if (mo > 12) {
      day = mo;
      month = d;
    }
    return new Date(Date.UTC(y, month - 1, day, parseInt(m[4] || '0', 10), parseInt(m[5] || '0', 10), parseInt(m[6] || '0', 10)));
  }
  // YYYY-MM-DD / ISO
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const dt = new Date(s.length === 10 ? `${s}T00:00:00Z` : s);
    return isNaN(dt.getTime()) ? null : dt;
  }
  const dt = new Date(s);
  return isNaN(dt.getTime()) ? null : dt;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

function formatDate(v: unknown, fmt: unknown): string {
  const d = parseDateFlexible(v);
  if (!d) return '';
  const f = typeof fmt === 'string' && fmt ? fmt : 'YYYY-MM-DD';
  return f
    .replace(/YYYY/g, String(d.getUTCFullYear()))
    .replace(/YY/g, String(d.getUTCFullYear()).slice(-2))
    .replace(/MM/g, pad(d.getUTCMonth() + 1))
    .replace(/DD/g, pad(d.getUTCDate()))
    .replace(/HH/g, pad(d.getUTCHours()))
    .replace(/mm/g, pad(d.getUTCMinutes()))
    .replace(/ss/g, pad(d.getUTCSeconds()));
}

/**
 * Make-compatible toString: arrays serialize to "[a,b,c]" (no spaces),
 * which is what blueprint string-surgery hacks (replace-chains that build
 * JSON arrays out of linked-record fields) rely on.
 */
export function makeToString(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return `[${v.map(makeToString).join(',')}]`;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function toDisplayString(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(toDisplayString).join(', ');
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function callFunction(name: string, args: unknown[]): unknown {
  const a = args;
  switch (name) {
    case 'formatDate':
      return formatDate(a[0], a[1]);
    case 'parseDate':
      return parseDateFlexible(a[0]);
    case 'now':
      return new Date().toISOString();
    case 'ifempty':
      return isEmptyValue(a[0]) ? a[1] : a[0];
    case 'if':
      return truthy(a[0]) ? a[1] : a[2];
    case 'replace': {
      const s = toDisplayString(a[0]);
      const find = toDisplayString(a[1]);
      const repl = toDisplayString(a[2]);
      if (!find) return s;
      return s.split(find).join(repl);
    }
    case 'toString':
      return makeToString(a[0]);
    case 'toNumber':
    case 'parseNumber':
      return Number(a[0]);
    case 'length':
      return Array.isArray(a[0]) ? a[0].length : toDisplayString(a[0]).length;
    case 'lower':
      return toDisplayString(a[0]).toLowerCase();
    case 'upper':
      return toDisplayString(a[0]).toUpperCase();
    case 'capitalize': {
      const s = toDisplayString(a[0]);
      return s.charAt(0).toUpperCase() + s.slice(1);
    }
    case 'trim':
      return toDisplayString(a[0]).trim();
    case 'substring':
      return toDisplayString(a[0]).substring(Number(a[1]), a[2] !== undefined ? Number(a[2]) : undefined);
    case 'split':
      return toDisplayString(a[0]).split(toDisplayString(a[1]));
    case 'join':
      return (Array.isArray(a[0]) ? a[0] : [a[0]]).map(toDisplayString).join(toDisplayString(a[1] ?? ','));
    case 'first':
      return Array.isArray(a[0]) ? a[0][0] : a[0];
    case 'last':
      return Array.isArray(a[0]) ? a[0][a[0].length - 1] : a[0];
    case 'get': {
      const path = toDisplayString(a[1]).split('.');
      let cur: unknown = a[0];
      for (const p of path) cur = getProp(cur, p);
      return cur;
    }
    case 'contains': {
      if (Array.isArray(a[0])) return a[0].some((x) => toDisplayString(x) === toDisplayString(a[1]));
      return toDisplayString(a[0]).includes(toDisplayString(a[1]));
    }
    case 'emptyarray':
      return [];
    case 'flatten':
      return Array.isArray(a[0]) ? a[0].flat(Infinity) : a[0];
    case 'distinct':
      return Array.isArray(a[0]) ? Array.from(new Set(a[0].map((x) => JSON.stringify(x)))).map((x) => JSON.parse(x)) : a[0];
    case 'sum':
      return (Array.isArray(a[0]) ? a[0] : args).reduce((acc: number, v) => acc + (Number(v) || 0), 0);
    case 'round':
      return Math.round(Number(a[0]));
    case 'floor':
      return Math.floor(Number(a[0]));
    case 'ceil':
      return Math.ceil(Number(a[0]));
    case 'abs':
      return Math.abs(Number(a[0]));
    case 'max':
      return Math.max(...(Array.isArray(a[0]) ? a[0] : args).map(Number));
    case 'min':
      return Math.min(...(Array.isArray(a[0]) ? a[0] : args).map(Number));
    case 'addDays': {
      const d = parseDateFlexible(a[0]);
      if (!d) return '';
      d.setUTCDate(d.getUTCDate() + Number(a[1] || 0));
      return d.toISOString();
    }
    case 'encodeURL':
      return encodeURIComponent(toDisplayString(a[0]));
    case 'base64':
      return Buffer.from(toDisplayString(a[0]), 'utf8').toString('base64');
    case 'toBinary':
      return toDisplayString(a[0]);
    case 'md5':
    case 'sha1':
    case 'sha256': {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const crypto = require('crypto') as typeof import('crypto');
      return crypto.createHash(name).update(toDisplayString(a[0])).digest('hex');
    }
    default:
      // Unknown function: return first argument so flows degrade gracefully.
      return a[0];
  }
}

export function truthy(v: unknown): boolean {
  if (typeof v === 'string') return v !== '' && v.toLowerCase() !== 'false';
  if (Array.isArray(v)) return v.length > 0;
  return !!v;
}

// ---------------------------------------------------------------------------
// Template evaluation

const TEMPLATE_RE = /\{\{([\s\S]*?)\}\}/g;

/** Evaluate one bare expression string (no surrounding braces). */
export function evalExpression(src: string, scope: Scope): unknown {
  try {
    return new ExprEval(src, scope).evaluate();
  } catch {
    return undefined;
  }
}

/**
 * Evaluate a mapper value. Strings containing exactly one {{expr}} return the
 * raw value (arrays/objects preserved); mixed strings are concatenated.
 * Objects and arrays are evaluated recursively.
 */
export function evalTemplate(input: unknown, scope: Scope): unknown {
  if (typeof input === 'string') {
    const matches = [...input.matchAll(TEMPLATE_RE)];
    if (matches.length === 0) return input;
    // A string that is exactly one {{expr}} returns the raw value.
    if (matches.length === 1 && input.trim() === matches[0][0]) {
      return evalExpression(matches[0][1], scope);
    }
    return input.replace(TEMPLATE_RE, (_m, expr) => toDisplayString(evalExpression(expr, scope)));
  }
  if (Array.isArray(input)) {
    return input.map((v) => evalTemplate(v, scope));
  }
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) out[k] = evalTemplate(v, scope);
    return out;
  }
  return input;
}
