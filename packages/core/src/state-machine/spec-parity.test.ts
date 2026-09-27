/**
 * Drift guard: the exported transition tables must equal the markdown tables in
 * docs/00-domain-model.md (§4, §15.1–§15.8) — same (from, to, actor set). The DB seed generator
 * parses the same tables, so code, DB and doc cannot diverge silently.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TERMINAL_TRANSACTION_STATUSES, TRANSACTION_STATUSES } from '../domain';
import { edgeKeys, extractSection, parseArrowSentence, parseTransitionTable } from '../testing/spec-tables';
import {
  DISPUTE_TRANSITIONS,
  FX_LOCK_TRANSITIONS,
  type Fsm,
  KYC_TRANSITIONS,
  PAYMENT_TRANSITIONS,
  PAYOUT_TRANSITIONS,
  PRICE_CONFIRMATION_TRANSITIONS,
  QUOTE_TRANSITIONS,
  REFUND_TRANSITIONS,
  TRANSACTION_TRANSITIONS,
  TRIP_TRANSITIONS,
  type TransitionDef,
  disputeFsm,
  fxLockFsm,
  kycSubmissionFsm,
  paymentFsm,
  payoutFsm,
  priceConfirmationFsm,
  quoteFsm,
  refundFsm,
  transactionFsm,
  tripFsm,
} from './index';

const DOC = readFileSync(new URL('../../../../docs/00-domain-model.md', import.meta.url), 'utf8');

function codeKeys<S extends string>(table: readonly TransitionDef<S>[]): string[] {
  return edgeKeys(table.map((t) => ({ from: t.from, to: t.to, actors: t.actors })));
}

function statesIn(edges: readonly { from: string; to: string }[]): string[] {
  return [...new Set(edges.flatMap((e) => [e.from, e.to]))].sort();
}

describe('§4 transaction table ↔ TRANSACTION_TRANSITIONS', () => {
  const section = extractSection(DOC, '## 4.');
  const edges = parseTransitionTable(section);

  it('has identical (from, to, actor set) edges', () => {
    expect(edges.length).toBeGreaterThan(30);
    expect(codeKeys(TRANSACTION_TRANSITIONS)).toEqual(edgeKeys(edges));
  });

  it('has no duplicate edges in the doc', () => {
    const pairs = edges.map((e) => `${e.from}→${e.to}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('status and terminal lists match', () => {
    const list = (label: string) =>
      (new RegExp(`^${label}: (.+)$`, 'm').exec(section)?.[1] ?? '')
        .replace(/[`.]/g, '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .sort();
    expect(list('Status')).toEqual([...TRANSACTION_STATUSES].sort());
    expect(list('Terminal')).toEqual([...TERMINAL_TRANSACTION_STATUSES].sort());
    expect(transactionFsm.definition.states).toEqual(TRANSACTION_STATUSES);
  });
});

describe('§15 secondary state machines ↔ exported tables', () => {
  const cases: ReadonlyArray<{
    heading: string;
    table: readonly TransitionDef<string>[];
    fsm: Fsm<string, never>;
  }> = [
    { heading: '### 15.1', table: TRIP_TRANSITIONS, fsm: tripFsm as unknown as Fsm<string, never> },
    { heading: '### 15.2', table: PRICE_CONFIRMATION_TRANSITIONS, fsm: priceConfirmationFsm as unknown as Fsm<string, never> },
    { heading: '### 15.3', table: DISPUTE_TRANSITIONS, fsm: disputeFsm as unknown as Fsm<string, never> },
    { heading: '### 15.4', table: KYC_TRANSITIONS, fsm: kycSubmissionFsm as unknown as Fsm<string, never> },
    { heading: '### 15.5', table: PAYMENT_TRANSITIONS, fsm: paymentFsm as unknown as Fsm<string, never> },
    { heading: '### 15.6', table: REFUND_TRANSITIONS, fsm: refundFsm as unknown as Fsm<string, never> },
    { heading: '### 15.7', table: PAYOUT_TRANSITIONS, fsm: payoutFsm as unknown as Fsm<string, never> },
  ];

  for (const { heading, table, fsm } of cases) {
    describe(`${heading} ${fsm.definition.name}`, () => {
      const edges = parseTransitionTable(extractSection(DOC, heading));

      it('has identical (from, to, actor set) edges', () => {
        expect(edges.length).toBeGreaterThan(0);
        expect(codeKeys(table)).toEqual(edgeKeys(edges));
      });

      it('uses exactly the FSM’s states', () => {
        expect(statesIn(edges)).toEqual([...fsm.definition.states].sort());
      });

      it('implements every guard code the doc names', () => {
        for (const e of edges.filter((x) => x.guardCode !== null)) {
          expect(fsm.findTransition(e.from, e.to)?.guardCode, `${e.from}→${e.to}`).toBe(e.guardCode);
        }
      });
    });
  }

  describe('### 15.8 quote & FX lock (prose)', () => {
    const section = extractSection(DOC, '### 15.8');
    it('quote edges match', () => {
      const edges = parseArrowSentence(section, 'Quote');
      expect(codeKeys(QUOTE_TRANSITIONS)).toEqual(edgeKeys(edges));
      expect(statesIn(edges)).toEqual([...quoteFsm.definition.states].sort());
    });
    it('FX lock edges match', () => {
      const edges = parseArrowSentence(section, 'FX lock');
      expect(codeKeys(FX_LOCK_TRANSITIONS)).toEqual(edgeKeys(edges));
      expect(statesIn(edges)).toEqual([...fxLockFsm.definition.states].sort());
    });
  });
});

describe('spec-table parser', () => {
  it('expands {A, B} source sets and sorts actors', () => {
    const md = [
      '| Dari | Ke | Aktor | Guard |',
      '|---|---|---|---|',
      '| {X, Y} | Z | SYSTEM, ADMIN | `SOME_GUARD`: text |',
    ].join('\n');
    expect(parseTransitionTable(md)).toEqual([
      { from: 'X', to: 'Z', actors: ['ADMIN', 'SYSTEM'], guardCode: 'SOME_GUARD' },
      { from: 'Y', to: 'Z', actors: ['ADMIN', 'SYSTEM'], guardCode: 'SOME_GUARD' },
    ]);
  });
});
