import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClaudePaths, OAuthAccount, resolvePaths, SavedLogin } from '../src/claudeFiles';
import { KeyValueStore, SecretStore } from '../src/profileStore';

/** Shared by unit and integration tests. All tokens and IDs here are fake. */

const DAY = 24 * 60 * 60 * 1000;

export function fakeAccount(name: string, org = `org-${name}`): OAuthAccount {
  return {
    accountUuid: `acct-${name}`,
    emailAddress: `${name.toLowerCase()}@example.test`,
    organizationUuid: org,
    organizationName: `${name} Org`,
    displayName: name,
    profileFetchedAt: 1,
  };
}

export interface FakeCredentialsOptions {
  version?: number;
  org?: string;
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
}

export function fakeCredentials(name: string, options: FakeCredentialsOptions = {}): string {
  const version = options.version ?? 1;
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: `fake-access-${name}-${version}`,
      refreshToken: `fake-refresh-${name}-${version}`,
      expiresAt: options.expiresAt ?? Date.now() + version * 60_000 + 8 * 60 * 60 * 1000,
      refreshTokenExpiresAt: options.refreshTokenExpiresAt ?? Date.now() + 30 * DAY,
      scopes: ['user:inference'],
      subscriptionType: 'pro',
    },
    organizationUuid: options.org ?? `org-${name}`,
  });
}

export function fakeLogin(name: string, options: FakeCredentialsOptions = {}): SavedLogin {
  return { credentialsRaw: fakeCredentials(name, options), account: fakeAccount(name, options.org) };
}

/** The cachedUsageUtilization entry Claude Code keeps in .claude.json (trimmed). */
export function fakeUsageCache(account: OAuthAccount, fetchedAtMs: number, session = 42, weekly = 61): object {
  const window = (utilization: number, hours: number) => ({
    utilization,
    resets_at: new Date(fetchedAtMs + hours * 3_600_000).toISOString(),
    limit_dollars: null,
  });
  return {
    fetchedAtMs,
    accountUuid: account.accountUuid,
    utilization: { five_hour: window(session, 3), seven_day: window(weekly, 72), seven_day_opus: null, extra_usage: { is_enabled: false } },
  };
}

/** Other keys Claude keeps in .claude.json, which a switch must leave alone. */
export const OTHER_CONFIG = {
  numStartups: 42,
  theme: 'dark',
  projects: { 'C:\\work\\app': { allowedTools: [] } },
  hasCompletedOnboarding: true,
};

const fakeHomes: string[] = [];

export async function makeFakeHome(): Promise<{ home: string; paths: ClaudePaths }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'roster-test-home-'));
  fakeHomes.push(home);
  return { home, paths: resolvePaths({}, home) };
}

export async function removeFakeHomes(): Promise<void> {
  for (const home of fakeHomes.splice(0)) {
    await fs.rm(home, { recursive: true, force: true });
  }
}

/** Writes a live login the way Claude does: two-space JSON with no trailing newline. */
export async function writeLive(paths: ClaudePaths, login: SavedLogin | null, extra: object = OTHER_CONFIG): Promise<void> {
  await fs.mkdir(paths.configDir, { recursive: true });
  if (login) {
    await fs.writeFile(paths.credentialsFile, login.credentialsRaw);
  } else {
    await fs.rm(paths.credentialsFile, { force: true });
  }
  const config = login ? { ...extra, oauthAccount: login.account } : { ...extra };
  await fs.writeFile(paths.globalConfigFile, JSON.stringify(config, null, 2));
}

export async function readFiles(paths: ClaudePaths): Promise<{ credentials: string | null; config: string }> {
  const credentials = await fs.readFile(paths.credentialsFile, 'utf8').catch(() => null);
  return { credentials, config: await fs.readFile(paths.globalConfigFile, 'utf8') };
}

export class MemoryState implements KeyValueStore {
  readonly data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    const value = this.data.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.data.delete(key);
    } else {
      this.data.set(key, structuredClone(value));
    }
  }
}

export class MemorySecrets implements SecretStore {
  readonly data = new Map<string, string>();
  async get(key: string): Promise<string | undefined> {
    return this.data.get(key);
  }
  async store(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}
