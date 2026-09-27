import type { Actor } from '../domain';
import { CoreError } from '../errors';

/** A guard returns null when satisfied, or a failure (code + message). Missing context = failure. */
export type GuardFailure = { readonly code: string; readonly message: string };
export type Guard<C> = (ctx: C, actor: Actor) => GuardFailure | null;

export interface TransitionDef<S extends string> {
  readonly from: S;
  readonly to: S;
  readonly actors: readonly Actor[];
  /** Key into the FSM's guard table; null = no guard. */
  readonly guardCode: string | null;
  readonly description: string;
}

export interface FsmDefinition<S extends string, C> {
  readonly name: string;
  readonly states: readonly S[];
  readonly initial: S;
  readonly terminal: readonly S[];
  readonly transitions: readonly TransitionDef<S>[];
  readonly guards: Readonly<Record<string, Guard<C>>>;
}

export type TransitionCheck<S extends string> =
  | { readonly ok: true; readonly transition: TransitionDef<S> }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface Fsm<S extends string, C> {
  readonly definition: FsmDefinition<S, C>;
  isState(value: unknown): value is S;
  isTerminal(state: S): boolean;
  transitionsFrom(state: S): readonly TransitionDef<S>[];
  findTransition(from: S, to: S): TransitionDef<S> | undefined;
  /** Structural + actor + guard check. Unknown/terminal/undefined transitions fail closed. */
  canTransition(from: S, to: S, actor: Actor, ctx: C): TransitionCheck<S>;
  /** Throws CoreError with the failure code. */
  assertTransition(from: S, to: S, actor: Actor, ctx: C): TransitionDef<S>;
  /** Target states this actor may request from `from` (guards not evaluated). */
  nextAllowed(from: S, actor: Actor): S[];
  /** Target states whose guard also passes for `ctx`. */
  nextAvailable(from: S, actor: Actor, ctx: C): S[];
  reachableFrom(state: S): Set<S>;
}

export function createFsm<S extends string, C>(def: FsmDefinition<S, C>): Fsm<S, C> {
  const states = new Set<string>(def.states);
  const terminal = new Set<string>(def.terminal);
  const byFrom = new Map<S, TransitionDef<S>[]>();
  const seen = new Set<string>();
  for (const t of def.transitions) {
    if (!states.has(t.from) || !states.has(t.to)) {
      throw new CoreError('FSM_DEFINITION_INVALID', `${def.name}: unknown state in ${t.from}→${t.to}`);
    }
    if (terminal.has(t.from)) {
      throw new CoreError('FSM_DEFINITION_INVALID', `${def.name}: terminal state ${t.from} has an exit`);
    }
    if (t.guardCode !== null && !def.guards[t.guardCode]) {
      throw new CoreError('FSM_DEFINITION_INVALID', `${def.name}: missing guard ${t.guardCode}`);
    }
    if (t.actors.length === 0) {
      throw new CoreError('FSM_DEFINITION_INVALID', `${def.name}: ${t.from}→${t.to} has no actors`);
    }
    const key = `${t.from}→${t.to}`;
    if (seen.has(key)) throw new CoreError('FSM_DEFINITION_INVALID', `${def.name}: duplicate transition ${key}`);
    seen.add(key);
    const list = byFrom.get(t.from) ?? [];
    list.push(t);
    byFrom.set(t.from, list);
  }

  const isState = (value: unknown): value is S => typeof value === 'string' && states.has(value);
  const findTransition = (from: S, to: S): TransitionDef<S> | undefined =>
    byFrom.get(from)?.find((t) => t.to === to);

  const canTransition = (from: S, to: S, actor: Actor, ctx: C): TransitionCheck<S> => {
    if (!isState(from)) return { ok: false, code: 'UNKNOWN_STATUS', message: `${def.name}: unknown status ${String(from)}` };
    if (!isState(to)) return { ok: false, code: 'UNKNOWN_STATUS', message: `${def.name}: unknown status ${String(to)}` };
    if (terminal.has(from)) {
      return { ok: false, code: 'TERMINAL_STATUS', message: `${def.name}: ${from} is terminal` };
    }
    const t = findTransition(from, to);
    if (!t) return { ok: false, code: 'INVALID_TRANSITION', message: `${def.name}: ${from} → ${to} is not allowed` };
    if (!t.actors.includes(actor)) {
      return {
        ok: false,
        code: 'ACTOR_NOT_ALLOWED',
        message: `${def.name}: ${actor} may not move ${from} → ${to} (allowed: ${t.actors.join(', ')})`,
      };
    }
    if (t.guardCode !== null) {
      const guard = def.guards[t.guardCode] as Guard<C>;
      const failure = guard(ctx, actor);
      if (failure) return { ok: false, code: failure.code, message: failure.message };
    }
    return { ok: true, transition: t };
  };

  return {
    definition: def,
    isState,
    isTerminal: (s) => terminal.has(s),
    transitionsFrom: (s) => byFrom.get(s) ?? [],
    findTransition,
    canTransition,
    assertTransition(from, to, actor, ctx) {
      const r = canTransition(from, to, actor, ctx);
      if (!r.ok) throw new CoreError(r.code, r.message, { fsm: def.name, from, to, actor });
      return r.transition;
    },
    nextAllowed(from, actor) {
      return (byFrom.get(from) ?? []).filter((t) => t.actors.includes(actor)).map((t) => t.to);
    },
    nextAvailable(from, actor, ctx) {
      return (byFrom.get(from) ?? []).filter((t) => canTransition(from, t.to, actor, ctx).ok).map((t) => t.to);
    },
    reachableFrom(state) {
      const out = new Set<S>([state]);
      const queue: S[] = [state];
      while (queue.length > 0) {
        const s = queue.shift() as S;
        for (const t of byFrom.get(s) ?? []) {
          if (!out.has(t.to)) {
            out.add(t.to);
            queue.push(t.to);
          }
        }
      }
      return out;
    },
  };
}

/** Helper to compose guard checks: returns the first failure. */
export function firstFailure(...checks: ReadonlyArray<GuardFailure | null>): GuardFailure | null {
  for (const c of checks) if (c) return c;
  return null;
}

export function requireTrue(value: boolean | undefined, code: string, message: string): GuardFailure | null {
  return value === true ? null : { code, message };
}
