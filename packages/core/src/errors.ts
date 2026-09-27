/**
 * Error type thrown by core engines for *programming / input contract* violations
 * (unknown currency, non-integer money, mismatched FX lock, …).
 *
 * Business outcomes (limit exceeded, rule not found, guard failed) are returned as
 * values, never thrown, so the API can map them to user-facing responses.
 */
export class CoreError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
    this.details = details;
  }
}

export function invariant(
  condition: unknown,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): asserts condition {
  if (!condition) throw new CoreError(code, message, details);
}

/** A machine-readable reason with a human message (used across engines). */
export interface Reason {
  readonly code: string;
  readonly message: string;
}
