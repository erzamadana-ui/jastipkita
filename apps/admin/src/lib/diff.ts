import type { DiffEntry } from '../api/types';

/** Structural JSON diff — same algorithm as the API (apps/api/src/modules/admin/config/service.ts jsonDiff). */
export function jsonDiff(before: unknown, after: unknown, path = ''): DiffEntry[] {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (Array.isArray(before) && Array.isArray(after)) {
    const out: DiffEntry[] = [];
    const n = Math.max(before.length, after.length);
    for (let i = 0; i < n; i++) {
      const p = `${path}[${i}]`;
      if (i >= before.length) out.push({ path: p, op: 'added', after: after[i] });
      else if (i >= after.length) out.push({ path: p, op: 'removed', before: before[i] });
      else out.push(...jsonDiff(before[i], after[i], p));
    }
    return out;
  }
  if (isObj(before) && isObj(after)) {
    const out: DiffEntry[] = [];
    for (const k of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in before)) out.push({ path: p, op: 'added', after: after[k] });
      else if (!(k in after)) out.push({ path: p, op: 'removed', before: before[k] });
      else out.push(...jsonDiff(before[k], after[k], p));
    }
    return out;
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ path: path || '$', op: 'changed', before, after }];
}

/** Immutable set at a path of keys/indices. */
export function setIn(root: unknown, path: (string | number)[], value: unknown): unknown {
  if (!path.length) return value;
  const [h, ...rest] = path;
  if (Array.isArray(root)) {
    const copy = [...root];
    copy[h as number] = setIn(copy[h as number], rest, value);
    return copy;
  }
  const obj = (root && typeof root === 'object' ? root : {}) as Record<string, unknown>;
  return { ...obj, [h as string]: setIn(obj[h as string], rest, value) };
}
