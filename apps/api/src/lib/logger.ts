/** Structured JSON logger with PII redaction. Output goes to stdout (Workers Logs / container logs). */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACT_KEYS = /(password|secret|token|authorization|cookie|otp|pin|code_hash|account_?number|id_?number|nik|ktp|passport|dob|phone|email|address|api_?key|signature)/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(level: LogLevel = 'info', base: Record<string, unknown> = {}, sink: (line: string) => void = (l) => console.log(l)): Logger {
  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const rec = { ts: new Date().toISOString(), level: lvl, msg, ...base, ...(fields ? (redact(fields) as object) : {}) };
    sink(JSON.stringify(rec));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (f) => createLogger(level, { ...base, ...f }, sink),
  };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};
