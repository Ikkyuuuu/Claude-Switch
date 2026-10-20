export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
};

const CLAUDE_TOKEN = /sk-ant-[A-Za-z0-9_-]+/g;
// Opaque tokens are long unbroken runs; UUIDs (36 chars) and path segments stay readable.
const LONG_OPAQUE_RUN = /[A-Za-z0-9_-]{48,}/g;

/**
 * Defense in depth: no message should ever contain a secret, but strip anything
 * token-shaped before text reaches a log, notification or error.
 */
export function redact(text: string): string {
  return text.replace(CLAUDE_TOKEN, 'sk-ant-[redacted]').replace(LONG_OPAQUE_RUN, '[redacted]');
}

export function errorMessage(err: unknown): string {
  return redact(err instanceof Error ? err.message : String(err));
}
