import { existsSync, FSWatcher, readdirSync, statSync, watch } from 'node:fs';
import * as path from 'node:path';

/**
 * Whether the platform watches a folder tree by itself. Elsewhere (Linux),
 * a recursive fs.watch makes Node walk the tree and watch every file in it,
 * which blocks while it walks and can use up the system's file watches.
 */
const NATIVE_RECURSIVE_WATCH = process.platform === 'win32' || process.platform === 'darwin';

/**
 * Notices when Claude is being used, so usage can be checked right after a
 * reply instead of only on a timer. Claude Code appends each message of a
 * conversation to a .jsonl file under <config folder>/projects; Claude Switch
 * only notices that such a file changed, and never reads it.
 */
export class ClaudeActivity {
  /** By folder watched. */
  private readonly watchers = new Map<string, FSWatcher>();
  private retry: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    /** Claude's config folder: ~/.claude, or CLAUDE_CONFIG_DIR. */
    private readonly configDir: string,
    /** project: the conversation's project folder, under <config folder>/projects. */
    private readonly onActivity: (project: string) => void,
    private readonly retryMs = 60_000,
    /** Tests turn this off to try, on any platform, the watch per project folder that Linux uses. */
    private readonly recursive = NATIVE_RECURSIVE_WATCH,
  ) {}

  start(): void {
    if (this.disposed) {
      return;
    }
    const projects = path.join(this.configDir, 'projects');
    try {
      if (!existsSync(projects)) {
        // Claude Code makes it with the first conversation.
        this.watch(this.configDir, false, (name) => {
          if (name === 'projects' && existsSync(projects)) {
            this.closeAll();
            this.start();
          }
        });
      } else if (this.recursive) {
        this.watch(projects, true, (file) => this.changed(file));
      } else {
        // One watch for new project folders, and one per project folder for its conversations.
        this.watch(projects, false, (name) => (existsSync(projects) ? this.watchProject(projects, name) : this.startLater()));
        for (const entry of readdirSync(projects, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            this.watchProject(projects, entry.name);
          }
        }
      }
    } catch {
      // The folder may not exist yet, before Claude Code first runs.
      this.startLater();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.closeAll();
    clearTimeout(this.retry);
  }

  /** file: relative to the projects folder. */
  private changed(file: string): void {
    if (isConversationFile(path.join('projects', file))) {
      this.onActivity(file.split(/[\\/]/)[0]);
    }
  }

  private watchProject(projects: string, name: string): void {
    const dir = path.join(projects, name);
    let isFolder = false;
    try {
      isFolder = statSync(dir).isDirectory();
    } catch {
      // Removed.
    }
    if (!isFolder) {
      this.watchers.get(dir)?.close();
      this.watchers.delete(dir);
      return;
    }
    if (this.watchers.has(dir)) {
      return;
    }
    try {
      this.watch(dir, false, (file) => this.changed(path.join(name, file)), () => {
        this.watchers.get(dir)?.close();
        this.watchers.delete(dir);
      });
    } catch {
      // Removed again already.
    }
  }

  private watch(dir: string, recursive: boolean, onFile: (file: string) => void, onError = () => this.startLater()): void {
    const watcher = watch(dir, { recursive, persistent: false }, (_event, file) => {
      if (file) {
        onFile(String(file));
      }
    });
    watcher.on('error', onError);
    this.watchers.set(dir, watcher);
  }

  private closeAll(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
  }

  private startLater(): void {
    this.closeAll();
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
