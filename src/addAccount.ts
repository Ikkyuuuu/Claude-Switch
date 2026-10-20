import { ChildProcess, execFile, spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { delay, errorCode, readSnapshot, resolvePaths, sameSnapshot, SavedLogin, toSavedLogin } from './claudeFiles';
import { errorMessage, redact } from './log';
import { isValidEmail } from './webview/rules';

/**
 * Add Account runs the Claude Code CLI with CLAUDE_CONFIG_DIR pointing at a
 * fresh temp folder, so signing in there never touches the live login. This
 * module owns that folder and the CLI process; the prompts live in commands.ts.
 */

const LOGIN_DIR_PREFIX = 'claude-roster-login-';

export async function createLoginDir(root: string = os.tmpdir()): Promise<string> {
  return fs.mkdtemp(path.join(root, LOGIN_DIR_PREFIX));
}

/**
 * Deletes a folder made by createLoginDir. Refuses anything else, because the
 * folder briefly holds live tokens and a wrong path here would delete user data.
 */
export async function removeLoginDir(dir: string, root: string = os.tmpdir()): Promise<void> {
  const resolved = path.resolve(dir);
  if (path.dirname(resolved) !== path.resolve(root) || !path.basename(resolved).startsWith(LOGIN_DIR_PREFIX)) {
    throw new Error(`Refusing to delete ${resolved}: it is not a Claude Switch sign-in folder.`);
  }
  const stat = await fs.lstat(resolved).catch(() => undefined);
  if (!stat) {
    return;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing to delete ${resolved}: it is not a plain folder.`);
  }
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

export interface WaitForLoginOptions {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Polls the sign-in folder until both halves of a login exist and two polls in
 * a row agree, so a sign-in that is still being written is never captured.
 */
export async function waitForLogin(dir: string, options: WaitForLoginOptions = {}): Promise<SavedLogin> {
  const { intervalMs = 2000, timeoutMs = 15 * 60_000, signal } = options;
  const paths = resolvePaths({ CLAUDE_CONFIG_DIR: dir });
  const deadline = Date.now() + timeoutMs;
  let previous: SavedLogin | undefined;
  for (;;) {
    if (signal?.aborted) {
      throw new Error('Sign-in was cancelled.');
    }
    let login: SavedLogin | undefined;
    try {
      login = toSavedLogin(await readSnapshot(paths));
    } catch {
      // Claude is mid-write; the next poll will see the finished file.
    }
    if (login && previous && sameSnapshot(login, previous)) {
      return login;
    }
    previous = login;
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the sign-in to finish.');
    }
    await delay(intervalMs, signal).catch(() => undefined);
  }
}

export { isValidEmail };

/** Variables that would make Claude use an API key or token instead of the claude.ai login. */
const AUTH_OVERRIDES = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']);

/**
 * The full path of a command on PATH. On Windows, Node finds only .exe files
 * by itself, so an npm-installed claude.cmd would not start without this.
 * Relative PATH entries are skipped, so a project folder can never supply it.
 */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | undefined {
  const extensions = platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  for (const dir of pathValue.split(path.delimiter)) {
    const folder = dir.trim().replace(/^"(.*)"$/, '$1');
    if (!path.isAbsolute(folder)) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = path.join(folder, name + extension.toLowerCase());
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/** A copy of env without AUTH_OVERRIDES, matched case-insensitively as Windows does. */
export function withoutAuthOverrides(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const key of Object.keys(copy)) {
    if (AUTH_OVERRIDES.has(key.toUpperCase())) {
      delete copy[key];
    }
  }
  return copy;
}
const MAX_OUTPUT = 16_000;

export interface ClaudeLoginOptions {
  /** Claude Code CLI executable. */
  command: string;
  /** Arguments placed before `auth login`, so tests can run a fake CLI through node. */
  commandArgs?: string[];
  /** Sign-in folder from createLoginDir. */
  dir: string;
  /** Pre-fills the sign-in page. */
  email?: string;
  /** Base environment; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface ClaudeLoginExit {
  code: number | null;
  /** Last line Claude printed, with links and token-shaped text removed. */
  lastLine: string;
}

/**
 * Runs `claude auth login` in the background. Claude opens the browser and
 * finishes on its own; the printed link and a pasted code are fallbacks for
 * when the browser does not open or cannot reach Claude's local callback.
 */
export class ClaudeLogin {
  readonly exited: Promise<ClaudeLoginExit>;
  private readonly child: ChildProcess;
  private readonly viaShell: boolean;
  private readonly urlListeners = new Set<(url: string) => void>();
  private output = '';
  private signInUrl: string | undefined;
  private done = false;

  constructor(options: ClaudeLoginOptions) {
    if (options.email !== undefined && !isValidEmail(options.email)) {
      throw new Error('That email address is not valid.');
    }
    const args = [
      ...(options.commandArgs ?? []),
      'auth',
      'login',
      '--claudeai',
      ...(options.email ? ['--email', options.email] : []),
    ];
    const env = withoutAuthOverrides({ ...(options.env ?? process.env), CLAUDE_CONFIG_DIR: options.dir });
    // Node only starts .cmd/.bat files (an npm-installed claude) through a shell.
    // The arguments are fixed words plus a validated email, so nothing needs escaping.
    this.viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(options.command);
    this.child = spawn(this.viaShell ? `"${options.command}"` : options.command, args, {
      cwd: options.dir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: this.viaShell,
    });
    this.child.stdout?.on('data', (chunk: Buffer) => this.onOutput(chunk));
    this.child.stderr?.on('data', (chunk: Buffer) => this.onOutput(chunk));
    this.child.stdin?.on('error', () => undefined);
    this.exited = new Promise((resolve) => {
      const finish = (exit: ClaudeLoginExit) => {
        if (!this.done) {
          this.done = true;
          resolve(exit);
        }
      };
      this.child.once('error', (err) =>
        finish({
          code: null,
          lastLine: errorCode(err) === 'ENOENT' ? `Could not find the Claude Code CLI (${options.command}).` : errorMessage(err),
        }),
      );
      this.child.once('exit', (code) => finish({ code, lastLine: this.lastLine() }));
    });
  }

  /** The sign-in link Claude printed, once it has printed one. */
  get url(): string | undefined {
    return this.signInUrl;
  }

  get running(): boolean {
    return !this.done;
  }

  onUrl(listener: (url: string) => void): () => void {
    this.urlListeners.add(listener);
    return () => this.urlListeners.delete(listener);
  }

  /** Answers Claude's "Paste code here if prompted" with the code from the sign-in page. */
  sendCode(code: string): void {
    const trimmed = code.trim();
    if (!trimmed || /[\r\n]/.test(trimmed)) {
      throw new Error('Paste the code exactly as the sign-in page shows it.');
    }
    if (!this.running || !this.child.stdin?.writable) {
      throw new Error('The sign-in has already ended.');
    }
    this.child.stdin.write(`${trimmed}\n`);
  }

  cancel(): void {
    if (!this.running) {
      return;
    }
    if (this.viaShell && this.child.pid) {
      // Killing the shell would leave the CLI behind it running.
      execFile('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], { windowsHide: true }, () => undefined);
    } else {
      this.child.kill();
    }
  }

  private onOutput(chunk: Buffer): void {
    // Drop terminal colour and control sequences.
    const text = chunk
      .toString('utf8')
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
    this.output = (this.output + text).slice(-MAX_OUTPUT);
    if (!this.signInUrl) {
      // Only a link followed by whitespace is complete; output can split it across chunks.
      const match = /https:\/\/[^\s"'<>]+(?=\s)/.exec(this.output);
      if (match) {
        this.signInUrl = match[0];
        for (const listener of this.urlListeners) {
          listener(match[0]);
        }
      }
    }
  }

  private lastLine(): string {
    const lines = this.output
      .split(/\r?\n/)
      .map((line) => line.replace(/https:\/\/\S+/g, '<link>').trim())
      .filter((line) => line && !/^Paste code here/i.test(line));
    return redact(lines[lines.length - 1] ?? '').slice(0, 200);
  }
}
