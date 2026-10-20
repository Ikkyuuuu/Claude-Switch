import { randomUUID } from 'node:crypto';
import { promises as fs, watchFile, unwatchFile, Stats } from 'node:fs';
import * as path from 'node:path';
import { atomicWrite } from './claudeFiles';

/** Written by the window that switched; every other window offers to reload. */
export interface SwitchSignal {
  id: string;
  /** vscode.env.sessionId of the window that switched. */
  source: string;
  alias?: string;
  at: string;
}

const SIGNAL_FILE = 'switch-signal.json';

/**
 * Cross-window notification through a file in the extension's global storage
 * folder, which every window on this machine shares. Uses stat polling, which
 * behaves the same on every platform and costs one stat per interval.
 */
export class WindowSync {
  private readonly file: string;
  private lastSeen: string | undefined;
  private started = false;

  constructor(
    private readonly dir: string,
    private readonly source: string,
    private readonly onSignal: (signal: SwitchSignal) => void,
    private readonly intervalMs = 1500,
  ) {
    this.file = path.join(dir, SIGNAL_FILE);
  }

  async start(): Promise<void> {
    // Signals from before this window started are old news.
    this.lastSeen = (await this.read())?.id;
    watchFile(this.file, { interval: this.intervalMs, persistent: false }, this.listener);
    this.started = true;
  }

  async publish(alias?: string): Promise<void> {
    const signal: SwitchSignal = { id: randomUUID(), source: this.source, alias, at: new Date().toISOString() };
    this.lastSeen = signal.id;
    await fs.mkdir(this.dir, { recursive: true });
    await atomicWrite(this.file, JSON.stringify(signal));
  }

  dispose(): void {
    if (this.started) {
      unwatchFile(this.file, this.listener);
      this.started = false;
    }
  }

  private readonly listener = (current: Stats, previous: Stats) => {
    if (current.mtimeMs !== previous.mtimeMs) {
      void this.check();
    }
  };

  private async check(): Promise<void> {
    const signal = await this.read();
    if (!signal || signal.id === this.lastSeen) {
      return;
    }
    this.lastSeen = signal.id;
    if (signal.source !== this.source) {
      this.onSignal(signal);
    }
  }

  private async read(): Promise<SwitchSignal | undefined> {
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<SwitchSignal>;
      if (typeof data.id !== 'string' || typeof data.source !== 'string') {
        return undefined;
      }
      return {
        id: data.id,
        source: data.source,
        alias: typeof data.alias === 'string' ? data.alias : undefined,
        at: String(data.at),
      };
    } catch {
      return undefined;
    }
  }
}
