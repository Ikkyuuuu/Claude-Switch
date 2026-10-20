import { randomUUID } from 'node:crypto';
import type { PlanInfo, RenewalSetting, UsageInfo } from './accountDetails';
import { identityOf, LoginSnapshot, OAuthAccount, SavedLogin } from './claudeFiles';

/** The subset of vscode.Memento that Claude Switch uses (globalState). */
export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** The subset of vscode.SecretStorage that Claude Switch uses. */
export interface SecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export type ProfileStatus = 'ok' | 'needs-relogin';

/** Non-secret display data, kept in globalState. */
export interface ProfileMeta {
  id: string;
  alias: string;
  /** Display only. */
  email: string;
  /** Hash of account + organization IDs, used to recognise the live login. */
  identity: string;
  addedAt: string;
  lastUsedAt?: string;
  status: ProfileStatus;
  plan?: PlanInfo;
  /** The last usage numbers seen while this account was active. */
  usage?: UsageInfo;
  /** A renewal date the user entered, which replaces the estimate. */
  renewal?: RenewalSetting;
}

export interface BackupMeta {
  slot: number;
  at: string;
  fromProfileId?: string;
  toProfileId?: string;
  /** Identity hash of the backed-up login, so removing a profile also wipes its backups. */
  identity?: string;
}

export interface LastSwitch {
  profileId: string;
  at: number;
}

const PROFILES_KEY = 'roster.profiles';
const BACKUPS_KEY = 'roster.backups';
const DISMISSED_KEY = 'roster.dismissedIdentities';
const LAST_SWITCH_KEY = 'roster.lastSwitch';
export const MAX_BACKUPS = 3;

const credentialsKey = (id: string) => `cred:${id}`;
const accountKey = (id: string) => `acct:${id}`;
const backupKey = (slot: number) => `backup:${slot}`;

export class ProfileStore {
  constructor(
    private readonly state: KeyValueStore,
    private readonly secrets: SecretStore,
  ) {}

  list(): ProfileMeta[] {
    return [...(this.state.get<ProfileMeta[]>(PROFILES_KEY) ?? [])];
  }

  get(id: string): ProfileMeta | undefined {
    return this.list().find((p) => p.id === id);
  }

  findByAccount(account: OAuthAccount): ProfileMeta | undefined {
    const identity = identityOf(account);
    return this.list().find((p) => p.identity === identity);
  }

  async add(alias: string, login: SavedLogin): Promise<ProfileMeta> {
    const existing = this.findByAccount(login.account);
    if (existing) {
      throw new Error(`This account is already saved as "${existing.alias}".`);
    }
    const meta: ProfileMeta = {
      id: randomUUID(),
      alias,
      email: login.account.emailAddress,
      identity: identityOf(login.account),
      addedAt: new Date().toISOString(),
      status: 'ok',
    };
    // Secrets first, so a profile never points at missing data.
    await this.writeLogin(meta.id, login);
    await this.saveList([...this.list(), meta]);
    return meta;
  }

  async getLogin(id: string): Promise<SavedLogin | undefined> {
    const [credentialsRaw, accountJson] = await Promise.all([
      this.secrets.get(credentialsKey(id)),
      this.secrets.get(accountKey(id)),
    ]);
    if (!credentialsRaw || !accountJson) {
      return undefined;
    }
    try {
      return { credentialsRaw, account: JSON.parse(accountJson) as OAuthAccount };
    } catch {
      return undefined;
    }
  }

  async updateLogin(id: string, login: SavedLogin): Promise<void> {
    const meta = this.require(id);
    if (identityOf(login.account) !== meta.identity) {
      throw new Error(`That login belongs to a different account than "${meta.alias}".`);
    }
    await this.writeLogin(id, login);
    await this.patch(id, { email: login.account.emailAddress });
  }

  async rename(id: string, alias: string): Promise<void> {
    await this.patch(id, { alias });
  }

  async setStatus(id: string, status: ProfileStatus): Promise<void> {
    await this.patch(id, { status });
  }

  async markUsed(id: string): Promise<void> {
    await this.patch(id, { lastUsedAt: new Date().toISOString() });
  }

  async setDetails(id: string, details: Pick<ProfileMeta, 'plan'> | Pick<ProfileMeta, 'usage'>): Promise<void> {
    await this.patch(id, details);
  }

  /** undefined goes back to the estimate. */
  async setRenewal(id: string, renewal: RenewalSetting | undefined): Promise<void> {
    await this.patch(id, { renewal });
  }

  /** Deletes the profile, its secrets and every backup of its login. */
  async remove(id: string): Promise<void> {
    const meta = this.require(id);
    // Secrets first: an interruption leaves a visible profile to retry, never orphaned tokens.
    await this.secrets.delete(credentialsKey(id));
    await this.secrets.delete(accountKey(id));
    for (const backup of this.listBackups()) {
      if (backup.fromProfileId === id || backup.identity === meta.identity) {
        await this.removeBackup(backup.slot);
      }
    }
    await this.saveList(this.list().filter((p) => p.id !== id));
  }

  /** Most recent first. */
  listBackups(): BackupMeta[] {
    return [...(this.state.get<BackupMeta[]>(BACKUPS_KEY) ?? [])];
  }

  /** Saves a snapshot into a rotating set of MAX_BACKUPS slots, replacing the oldest. */
  async pushBackup(snapshot: LoginSnapshot, info: { fromProfileId?: string; toProfileId?: string }): Promise<BackupMeta> {
    const backups = this.listBackups();
    const used = new Set(backups.map((b) => b.slot));
    let slot = [...Array(MAX_BACKUPS).keys()].find((s) => !used.has(s));
    if (slot === undefined) {
      slot = backups[backups.length - 1].slot;
    }
    const meta: BackupMeta = {
      slot,
      at: new Date().toISOString(),
      fromProfileId: info.fromProfileId,
      toProfileId: info.toProfileId,
      identity: snapshot.account ? identityOf(snapshot.account) : undefined,
    };
    await this.secrets.store(backupKey(slot), JSON.stringify(snapshot));
    await this.state.update(BACKUPS_KEY, [meta, ...backups.filter((b) => b.slot !== slot)].slice(0, MAX_BACKUPS));
    return meta;
  }

  async getBackup(slot: number): Promise<LoginSnapshot | undefined> {
    const raw = await this.secrets.get(backupKey(slot));
    if (!raw) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as LoginSnapshot;
      return { credentialsRaw: parsed.credentialsRaw ?? null, account: parsed.account ?? null };
    } catch {
      return undefined;
    }
  }

  async removeBackup(slot: number): Promise<void> {
    await this.secrets.delete(backupKey(slot));
    await this.state.update(
      BACKUPS_KEY,
      this.listBackups().filter((b) => b.slot !== slot),
    );
  }

  /** Whether the user said "Don't ask again" about saving this login. */
  isDismissed(identity: string): boolean {
    return (this.state.get<string[]>(DISMISSED_KEY) ?? []).includes(identity);
  }

  async dismiss(identity: string): Promise<void> {
    const dismissed = this.state.get<string[]>(DISMISSED_KEY) ?? [];
    if (!dismissed.includes(identity)) {
      await this.state.update(DISMISSED_KEY, [...dismissed, identity]);
    }
  }

  getLastSwitch(): LastSwitch | undefined {
    return this.state.get<LastSwitch>(LAST_SWITCH_KEY);
  }

  async setLastSwitch(value: LastSwitch | undefined): Promise<void> {
    await this.state.update(LAST_SWITCH_KEY, value);
  }

  /** Wipes everything Claude Switch saved. The live Claude login is not touched. */
  async clearAll(): Promise<void> {
    for (const profile of this.list()) {
      await this.secrets.delete(credentialsKey(profile.id));
      await this.secrets.delete(accountKey(profile.id));
    }
    for (let slot = 0; slot < MAX_BACKUPS; slot++) {
      await this.secrets.delete(backupKey(slot));
    }
    for (const key of [PROFILES_KEY, BACKUPS_KEY, DISMISSED_KEY, LAST_SWITCH_KEY]) {
      await this.state.update(key, undefined);
    }
  }

  private async writeLogin(id: string, login: SavedLogin): Promise<void> {
    await this.secrets.store(credentialsKey(id), login.credentialsRaw);
    await this.secrets.store(accountKey(id), JSON.stringify(login.account));
  }

  private require(id: string): ProfileMeta {
    const meta = this.get(id);
    if (!meta) {
      throw new Error('That account is no longer saved in Claude Switch.');
    }
    return meta;
  }

  private async patch(id: string, changes: Partial<ProfileMeta>): Promise<void> {
    this.require(id);
    await this.saveList(this.list().map((p) => (p.id === id ? { ...p, ...changes } : p)));
  }

  private async saveList(profiles: ProfileMeta[]): Promise<void> {
    await this.state.update(PROFILES_KEY, profiles);
  }
}
