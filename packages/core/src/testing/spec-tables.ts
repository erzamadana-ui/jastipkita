/**
 * Parses the transition tables in docs/00-domain-model.md (same format the DB seed generator reads):
 *   | Dari | Ke | Aktor | Guard |
 *   | FROM or {A, B, C} | TO | ACTOR, ACTOR | guard text (may contain `GUARD_CODE`) |
 */
export interface SpecEdge {
  readonly from: string;
  readonly to: string;
  readonly actors: readonly string[];
  /** First UPPER_SNAKE code in backticks in the guard cell, if any. */
  readonly guardCode: string | null;
}

/** Text of the section whose heading line starts with `headingPrefix` (e.g. "## 4." or "### 15.2"). */
export function extractSection(markdown: string, headingPrefix: string): string {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`${headingPrefix} `) || l === headingPrefix);
  if (start < 0) throw new Error(`Section "${headingPrefix}" not found`);
  const level = (headingPrefix.match(/^#+/)?.[0] ?? '#').length;
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    const m = /^(#+)\s/.exec(line);
    if (m && (m[1] as string).length <= level) break;
    out.push(line);
  }
  return out.join('\n');
}

const clean = (cell: string): string => cell.replace(/`/g, '').trim();

export function parseTransitionTable(section: string): SpecEdge[] {
  const rows = section
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|'));
  const edges: SpecEdge[] = [];
  for (const row of rows) {
    const cells = row.slice(1, row.endsWith('|') ? -1 : undefined).split('|');
    if (cells.length < 3) continue;
    const [fromCell = '', toCell = '', actorCell = '', guardCell = ''] = cells;
    if (/^\s*:?-{3,}/.test(fromCell) || clean(fromCell) === 'Dari') continue;
    const fromText = clean(fromCell);
    const froms = fromText.startsWith('{')
      ? fromText
          .replace(/[{}]/g, '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
      : [fromText];
    const actors = clean(actorCell)
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .sort();
    const guardCode = /`([A-Z][A-Z0-9_]+)`/.exec(guardCell)?.[1] ?? null;
    for (const from of froms) edges.push({ from, to: clean(toCell), actors, guardCode });
  }
  return edges;
}

/**
 * §15.8 is prose: "Quote: `ACTIVE → ACCEPTED | EXPIRED | SUPERSEDED`, `ACCEPTED → SUPERSEDED` (SYSTEM).
 * FX lock: `ACTIVE → CONSUMED | EXPIRED` (SYSTEM)." The parenthesised actor list applies to every
 * edge of that sentence.
 */
export function parseArrowSentence(section: string, label: string): SpecEdge[] {
  const re = new RegExp(`${label}:([^\\n]*?)(?=\\s[A-Z][A-Za-z ]*:\\s|$)`, 'm');
  const text = re.exec(section)?.[1];
  if (text === undefined) throw new Error(`"${label}:" sentence not found`);
  const actorMatch = [...text.matchAll(/\(([A-Z_, ]+)\)/g)].at(-1);
  if (!actorMatch) throw new Error(`No actor list for "${label}"`);
  const actors = (actorMatch[1] as string)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .sort();
  const edges: SpecEdge[] = [];
  for (const seg of text.matchAll(/`([A-Z_]+)\s*→\s*([A-Z_|\s]+)`/g)) {
    for (const to of (seg[2] as string).split('|').map((x) => x.trim()).filter(Boolean)) {
      edges.push({ from: seg[1] as string, to, actors, guardCode: null });
    }
  }
  return edges;
}

/** Canonical "FROM→TO:ACTOR,ACTOR" keys, sorted, for set comparison. */
export function edgeKeys(edges: readonly { from: string; to: string; actors: readonly string[] }[]): string[] {
  return edges.map((e) => `${e.from}→${e.to}:${[...e.actors].sort().join(',')}`).sort();
}
