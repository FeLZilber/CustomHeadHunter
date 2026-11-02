const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

const SECRET_PATTERNS: RegExp[] = [
  /bot\d+:[\w-]+/g, // Telegram tokens appear in request paths.
  /(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/g,
];

export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((value, pattern) => value.replace(pattern, (_match, prefix) => {
    return typeof prefix === "string" ? `${prefix}[redacted]@` : "[redacted]";
  }), text);
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function createLogger(level: LogLevel = "info", write: (line: string) => void = console.log): Logger {
  const emit = (entryLevel: LogLevel, message: string, fields: Record<string, unknown> = {}) => {
    if (LEVELS[entryLevel] < LEVELS[level]) return;
    write(redact(JSON.stringify({ at: new Date().toISOString(), level: entryLevel, message, ...fields })));
  };
  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}
