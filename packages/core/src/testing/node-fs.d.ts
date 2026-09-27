// Test-only ambient declaration so spec-parity tests can read docs from disk without adding
// @types/node (engines stay free of Node typings). Vitest runs on Node, where this exists.
declare module 'node:fs' {
  export function readFileSync(path: string | URL, encoding: 'utf8'): string;
}
