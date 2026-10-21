import { ChildProcess, execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { withoutAuthOverrides } from './addAccount';
import { atomicWrite, errorCode } from './claudeFiles';

export interface UsageCheckOptions {
  /** Claude Code CLI executable. */
  command: string;
  /** Arguments placed before the CLI's own, so tests can run a fake CLI through node. */
  commandArgs?: string[];
  /** A folder of Claude Switch's own, so no project's settings or CLAUDE.md apply. */
  cwd: string;
  /** Base environment; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_LINE = 1_000_000;

/**
 * Asks Claude Code's CLI for the signed-in account's current usage, the way
 * Claude Code's own Account & Usage panel asks it. The CLI fetches the numbers
 * from Anthropic with its own login; Claude Switch never handles a token or
 * makes a network request itself.
 *
 * Talks to the CLI over its stream-json control channel ("get_usage"), which
 * Claude Code marks as experimental, so callers treat any failure as "no new
 * numbers". Resolves to the per-window utilization, the same shape as
 * cachedUsageUtilization.utilization in .claude.json.
 */
export function askClaudeForUsage(options: UsageCheckOptions): Promise<unknown> {
  const args = [
    ...(options.commandArgs ?? []),
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    // Only the login: no hooks, plugins, MCP servers or CLAUDE.md, and no saved session.
    '--safe-mode',
    '--strict-mcp-config',
    '--no-session-persistence',
  ];
  // Node only starts .cmd/.bat files (an npm-installed claude) through a shell. The arguments are fixed words.
  const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(options.command);
  const child = spawn(viaShell ? `"${options.command}"` : options.command, args, {
    cwd: options.cwd,
    env: withoutAuthOverrides(options.env ?? process.env),
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
    shell: viaShell,
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let usage: unknown;
    let buffer = '';
    const finish = (err?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (err) {
        stop(child, viaShell);
        reject(err);
      } else {
        resolve(usage);
      }
    };
    const send = (id: string, request: object) => {
      child.stdin?.write(`${JSON.stringify({ type: 'control_request', request_id: id, request })}\n`);
    };
    const timer = setTimeout(() => {
      if (usage === undefined) {
        finish(new Error('Claude did not answer in time.'));
      } else {
        // It answered but did not exit.
        stop(child, viaShell);
        finish();
      }
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdin?.on('error', () => undefined);
    child.once('error', (err) =>
      finish(errorCode(err) === 'ENOENT' ? new Error(`Could not find the Claude Code CLI (${options.command}).`) : err),
    );
    child.once('exit', (code) => {
      // After answering, the CLI exits once its input closes, having saved what it fetched.
      if (usage !== undefined) {
        finish();
      } else {
        finish(new Error(`Claude exited (code ${code}) without the usage.`));
      }
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const response = controlResponse(line);
        if (response?.request_id === 'init') {
          if (response.subtype === 'success') {
            send('usage', { subtype: 'get_usage', skip_behaviors: true });
          } else {
            finish(new Error('Claude did not start a session.'));
          }
        } else if (response?.request_id === 'usage') {
          const rateLimits = field(response.response, 'rate_limits');
          if (response.subtype !== 'success' || typeof rateLimits !== 'object' || rateLimits === null) {
            finish(new Error('Claude did not return the usage.'));
          } else {
            usage = rateLimits;
            child.stdin?.end();
          }
        }
      }
      if (buffer.length > MAX_LINE) {
        buffer = '';
      }
    });
    send('init', { subtype: 'initialize' });
  });
}

/** A reply has finished once Claude's conversation file has been still this long. */
export const ACTIVITY_QUIET_MS = 2_000;
/** During a long reply, check this often. */
export const ACTIVITY_MAX_WAIT_MS = 10_000;
/** Never two checks closer together than this. */
export const ACTIVITY_MIN_GAP_MS = 5_000;

export interface UsageSchedule {
  now: number;
  lastCheck: number;
  /** The check while Claude is idle, from claudeRoster.usageCheckSeconds. */
  intervalMs: number;
  /** When Claude was first used since the last check; 0 if it wasn't. */
  activitySince: number;
  /** When Claude was last used. */
  lastActivity: number;
}

/**
 * Whether to check usage now: shortly after Claude replies, when the numbers
 * change, and otherwise every intervalMs, for usage elsewhere such as claude.ai.
 */
export function usageCheckDue(s: UsageSchedule): boolean {
  const sinceCheck = s.now - s.lastCheck;
  if (s.activitySince && sinceCheck >= ACTIVITY_MIN_GAP_MS) {
    const replyFinished = s.now - s.lastActivity >= ACTIVITY_QUIET_MS;
    const longReply = s.now - s.activitySince >= ACTIVITY_MAX_WAIT_MS;
    if (replyFinished || longReply) {
      return true;
    }
  }
  return sinceCheck >= s.intervalMs;
}

/**
 * Clears the usage numbers the CLI saved in a usage check's own settings
 * folder (its CLAUDE_CONFIG_DIR, never ~/.claude). The CLI reuses numbers
 * younger than a minute; with none saved, it fetches fresh ones.
 */
export async function forgetSavedUsage(configDir: string): Promise<void> {
  const file = path.join(configDir, '.claude.json');
  let config: unknown;
  try {
    config = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (errorCode(err) !== 'ENOENT') {
      // Unreadable: the CLI starts the folder afresh.
      await fs.rm(file, { force: true });
    }
    return;
  }
  if (typeof config === 'object' && config !== null && 'cachedUsageUtilization' in config) {
    delete (config as Record<string, unknown>).cachedUsageUtilization;
    await atomicWrite(file, JSON.stringify(config, null, 2));
  }
}

function controlResponse(line: string): { request_id?: unknown; subtype?: unknown; response?: unknown } | undefined {
  if (!line.includes('"control_response"')) {
    return undefined;
  }
  try {
    const message = JSON.parse(line) as unknown;
    const response = field(message, 'response');
    return field(message, 'type') === 'control_response' && typeof response === 'object' && response !== null
      ? (response as { request_id?: unknown; subtype?: unknown; response?: unknown })
      : undefined;
  } catch {
    return undefined;
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function stop(child: ChildProcess, viaShell: boolean): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (viaShell && child.pid) {
    // Killing the shell would leave the CLI behind it running.
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => undefined);
  } else {
    child.kill();
  }
}
