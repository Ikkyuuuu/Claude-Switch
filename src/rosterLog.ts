import { Logger, redact } from './log';
import type { LogEntry } from './webview/protocol';

/**
 * The activity log shown in the Claude Switch tab. Keeps the most recent
 * entries in memory (nothing is written to disk) and forwards each one to a
 * sink, normally VS Code's "Claude Switch" output channel.
 */
export class RosterLog implements Logger {
  private readonly items: LogEntry[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly sink?: Logger,
    private readonly limit = 300,
    private readonly now: () => number = Date.now,
  ) {}

  info(message: string): void {
    this.add('info', message);
  }

  warn(message: string): void {
    this.add('warn', message);
  }

  error(message: string): void {
    this.add('error', message);
  }

  /** Oldest first. */
  get entries(): LogEntry[] {
    return [...this.items];
  }

  clear(): void {
    this.items.length = 0;
    this.notify();
  }

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Plain text for copying into a bug report. */
  toText(): string {
    return this.items.map((e) => `${new Date(e.at).toISOString()} [${e.level}] ${e.message}`).join('\n');
  }

  private add(level: LogEntry['level'], message: string): void {
    // Messages are written never to contain secrets; redact anyway.
    const safe = redact(message);
    this.sink?.[level](safe);
    this.items.push({ at: this.now(), level, message: safe });
    if (this.items.length > this.limit) {
      this.items.splice(0, this.items.length - this.limit);
    }
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
