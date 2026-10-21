import { FSWatcher, watch } from 'node:fs';

/**
 * Notices when Claude is being used, so usage can be checked right after a
 * reply instead of only on a timer. Claude Code appends each message of a
 * conversation to a .jsonl file under <config folder>/projects; Claude Switch
 * only notices that such a file changed, and never reads it.
 */
export class ClaudeActivity {
  private watcher: FSWatcher | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    /** Claude's config folder: ~/.claude, or CLAUDE_CONFIG_DIR. */
    private readonly configDir: string,
    /** project: the conversation's project folder, under <config folder>/projects. */
    private readonly onActivity: (project: string) => void,
    private readonly retryMs = 60_000,
  ) {}

  start(): void {
    if (this.disposed) {
      return;
    }
    try {
      this.watcher = watch(this.configDir, { recursive: true, persistent: false }, (_event, file) => {
        if (file && isConversationFile(String(file))) {
          this.onActivity(String(file).split(/[\\/]/)[1]);
        }
      });
      this.watcher.on('error', () => this.startLater());
    } catch {
      // The folder may not exist yet, before Claude Code first runs.
      this.startLater();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.close();
    clearTimeout(this.retry);
  }

  private startLater(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (!this.disposed && !this.retry) {
      this.retry = setTimeout(() => {
        this.retry = undefined;
        this.start();
      }, this.retryMs);
    }
  }
}

/** A conversation file, given relative to Claude's config folder: projects/<project>/…/<session>.jsonl. */
export function isConversationFile(relative: string): boolean {
  const parts = relative.split(/[\\/]/);
  return parts[0] === 'projects' && parts.length >= 3 && relative.endsWith('.jsonl');
}
