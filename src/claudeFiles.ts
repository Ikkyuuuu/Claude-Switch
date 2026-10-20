import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Where Claude Code keeps the two files that make up a login. */
export interface ClaudePaths {
  /** Folder that holds .credentials.json. */
  configDir: string;
  /** Login tokens. Documented for Linux and Windows. */
  credentialsFile: string;
  /** Global config; its oauthAccount key holds the signed-in identity. */
  globalConfigFile: string;
  /** True when CLAUDE_CONFIG_DIR decided the paths. */
  fromEnv: boolean;
}

/** The oauthAccount object in .claude.json. Unknown keys are kept as-is. */
export interface OAuthAccount {
  accountUuid: string;
  emailAddress: string;
  organizationUuid?: string | null;
  organizationName?: unknown;
  [key: string]: unknown;
}

/** The live login as found on disk; either half may be missing. Backups use this shape. */
export interface LoginSnapshot {
  /** Exact .credentials.json text, or null when the file does not exist. */
  credentialsRaw: string | null;
  /** oauthAccount from .claude.json, or null when the key is absent. */
  account: OAuthAccount | null;
}

/** A complete login, as saved in a profile. */
export interface SavedLogin {
  credentialsRaw: string;
  account: OAuthAccount;
}

/**
 * A Claude file is missing or not in the shape Claude Switch understands. Claude Switch refuses
 * to write when it sees one. Messages never include file content.
 */
export class ClaudeFileError extends Error {
  override name = 'ClaudeFileError';
}

const CREDENTIALS_NAME = '.credentials.json';
const GLOBAL_CONFIG_NAME = '.claude.json';
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 8;

export function resolvePaths(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): ClaudePaths {
  const custom = env.CLAUDE_CONFIG_DIR?.trim();
  if (custom) {
    const dir = path.resolve(custom);
    return {
      configDir: dir,
      credentialsFile: path.join(dir, CREDENTIALS_NAME),
      globalConfigFile: path.join(dir, GLOBAL_CONFIG_NAME),
      fromEnv: true,
    };
  }
  const dir = path.join(home, '.claude');
  return {
    configDir: dir,
    credentialsFile: path.join(dir, CREDENTIALS_NAME),
    globalConfigFile: path.join(home, GLOBAL_CONFIG_NAME),
    fromEnv: false,
  };
}

/** Short stable hash of account + organization. Used to match logins to profiles. */
export function identityOf(account: OAuthAccount): string {
  return createHash('sha256')
    .update(`${account.accountUuid}\n${account.organizationUuid ?? ''}`)
    .digest('hex')
    .slice(0, 32);
}

export function sameAccount(a: OAuthAccount | null, b: OAuthAccount | null): boolean {
  if (!a || !b) {
    return a === b;
  }
  return identityOf(a) === identityOf(b) && a.emailAddress === b.emailAddress;
}

export function sameSnapshot(a: LoginSnapshot, b: LoginSnapshot): boolean {
  return a.credentialsRaw === b.credentialsRaw && sameAccount(a.account, b.account);
}

/** The snapshot as a complete login, or undefined if it is signed out or half-written. */
export function toSavedLogin(snapshot: LoginSnapshot): SavedLogin | undefined {
  if (snapshot.credentialsRaw === null || !snapshot.account || !hasClaudeLogin(snapshot.credentialsRaw)) {
    return undefined;
  }
  return { credentialsRaw: snapshot.credentialsRaw, account: snapshot.account };
}

export function hasClaudeLogin(credentialsRaw: string): boolean {
  const oauth = parseCredentials(credentialsRaw).claudeAiOauth;
  return isPlainObject(oauth) && typeof oauth.accessToken === 'string' && oauth.accessToken.length > 0;
}

/** When the refresh token stops working, in epoch milliseconds, if Claude recorded it. */
export function refreshTokenExpiry(credentialsRaw: string): number | undefined {
  return oauthTime(credentialsRaw, 'refreshTokenExpiresAt');
}

/** When the access token expires, in epoch milliseconds. Later means a newer login. */
export function accessTokenExpiry(credentialsRaw: string): number | undefined {
  return oauthTime(credentialsRaw, 'expiresAt');
}

function oauthTime(credentialsRaw: string, key: string): number | undefined {
  const oauth = parseCredentials(credentialsRaw).claudeAiOauth;
  const value = isPlainObject(oauth) ? oauth[key] : undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value < 1e12 ? value * 1000 : value;
}

/**
 * False when the tokens and the identity name different organizations. That
 * happens when another Claude process wrote back an old login, so the pair must
 * not be saved into a profile.
 */
export function credentialsMatchAccount(credentialsRaw: string, account: OAuthAccount): boolean {
  const credentialsOrg = parseCredentials(credentialsRaw).organizationUuid;
  if (typeof credentialsOrg !== 'string' || typeof account.organizationUuid !== 'string') {
    return true;
  }
  return credentialsOrg === account.organizationUuid;
}

/** Reads the live login. Throws ClaudeFileError on an unexpected file shape. */
export async function readSnapshot(paths: ClaudePaths): Promise<LoginSnapshot> {
  const credentialsRaw = (await readTextIfExists(paths.credentialsFile)) ?? null;
  if (credentialsRaw !== null) {
    parseCredentials(credentialsRaw);
  }
  const configRaw = await readTextIfExists(paths.globalConfigFile);
  const account = configRaw === undefined ? null : accountFrom(parseGlobalConfig(configRaw));
  return { credentialsRaw, account };
}

/** Fails closed unless .claude.json exists and has a shape Claude Switch can patch. */
export async function assertGlobalConfigWritable(paths: ClaudePaths): Promise<void> {
  accountFrom(await readGlobalConfig(paths.globalConfigFile));
}

/** Replaces .credentials.json with exact text, or deletes it for null. */
export async function writeCredentials(paths: ClaudePaths, credentialsRaw: string | null): Promise<void> {
  if (credentialsRaw === null) {
    if (path.basename(paths.credentialsFile) !== CREDENTIALS_NAME) {
      throw new Error(`Refusing to delete unexpected file ${paths.credentialsFile}.`);
    }
    await fs.rm(paths.credentialsFile, { force: true });
    return;
  }
  parseCredentials(credentialsRaw);
  await fs.mkdir(path.dirname(paths.credentialsFile), { recursive: true });
  await atomicWrite(paths.credentialsFile, credentialsRaw);
}

/**
 * Sets (or removes, for null) only the oauthAccount key in .claude.json and
 * keeps every other key, the indentation and the line endings.
 */
export async function writeOauthAccount(paths: ClaudePaths, account: OAuthAccount | null): Promise<void> {
  const file = paths.globalConfigFile;
  const raw = await readTextIfExists(file);
  if (raw === undefined) {
    throw new ClaudeFileError(`${GLOBAL_CONFIG_NAME} was not found. Start Claude Code once, then try again.`);
  }
  const data = parseGlobalConfig(raw);
  accountFrom(data);
  if (account) {
    data.oauthAccount = account;
  } else {
    delete data.oauthAccount;
  }
  await atomicWrite(file, serializeLike(raw, data));
}

export interface AtomicWriteOptions {
  /** Replaceable for tests that simulate a locked file. */
  rename?: (from: string, to: string) => Promise<void>;
}

/**
 * Writes to a temp file in the same folder, then renames it over the target.
 * Retries the rename because Windows reports EPERM/EBUSY while another process
 * (such as the Claude extension) briefly has the file open.
 */
export async function atomicWrite(file: string, content: string, options: AtomicWriteOptions = {}): Promise<void> {
  const target = await realTarget(file);
  const mode = await existingMode(target);
  const tmp = `${target}.roster-${randomBytes(6).toString('hex')}.tmp`;
  const rename = options.rename ?? ((from: string, to: string) => fs.rename(from, to));
  await fs.writeFile(tmp, content, { encoding: 'utf8', mode, flag: 'wx' });
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await rename(tmp, target);
        return;
      } catch (err) {
        if (!RETRYABLE_RENAME_CODES.has(errorCode(err)) || attempt >= RENAME_ATTEMPTS) {
          throw err;
        }
        await delay(attempt * 50);
      }
    }
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

export async function readTextIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if (errorCode(err) === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
}

export function errorCode(err: unknown): string {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : '';
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Cancelled.'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function parseCredentials(raw: string): Record<string, unknown> {
  const data = parseJson(raw, CREDENTIALS_NAME);
  if (!isPlainObject(data)) {
    throw new ClaudeFileError(`${CREDENTIALS_NAME} has an unexpected format. Update Claude Switch.`);
  }
  return data;
}

async function readGlobalConfig(file: string): Promise<Record<string, unknown>> {
  const raw = await readTextIfExists(file);
  if (raw === undefined) {
    throw new ClaudeFileError(`${GLOBAL_CONFIG_NAME} was not found. Start Claude Code once, then try again.`);
  }
  return parseGlobalConfig(raw);
}

function parseGlobalConfig(raw: string): Record<string, unknown> {
  const data = parseJson(raw, GLOBAL_CONFIG_NAME);
  if (!isPlainObject(data)) {
    throw new ClaudeFileError(`${GLOBAL_CONFIG_NAME} has an unexpected format. Update Claude Switch.`);
  }
  return data;
}

function accountFrom(config: Record<string, unknown>): OAuthAccount | null {
  const value = config.oauthAccount;
  if (value === undefined || value === null) {
    return null;
  }
  if (
    !isPlainObject(value) ||
    typeof value.accountUuid !== 'string' ||
    typeof value.emailAddress !== 'string' ||
    (value.organizationUuid !== undefined && value.organizationUuid !== null && typeof value.organizationUuid !== 'string')
  ) {
    throw new ClaudeFileError(`oauthAccount in ${GLOBAL_CONFIG_NAME} has an unexpected format. Update Claude Switch.`);
  }
  return value as OAuthAccount;
}

/** JSON.parse whose error never echoes file content (V8 quotes the input in its messages). */
function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    throw new ClaudeFileError(`${label} is not valid JSON.`);
  }
}

function serializeLike(original: string, data: unknown): string {
  const indentMatch = /^﻿?\{\r?\n([ \t]+)"/.exec(original);
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  let text = indentMatch ? JSON.stringify(data, null, indentMatch[1]) : JSON.stringify(data);
  if (eol === '\r\n') {
    text = text.replace(/\n/g, '\r\n');
  }
  if (/\r?\n$/.test(original)) {
    text += eol;
  }
  return text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Writes through a symlinked dotfile instead of replacing the link. */
async function realTarget(file: string): Promise<string> {
  try {
    return await fs.realpath(file);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') {
      return file;
    }
    throw err;
  }
}

async function existingMode(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).mode & 0o777;
  } catch {
    return 0o600;
  }
}
