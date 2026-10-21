import { randomUUID } from 'node:crypto';
import type { PlanInfo, RenewalSetting, UsageInfo } from './accountDetails';
import { identityOf, LoginSnapshot, OAuthAccount, SavedLogin } from './claudeFiles';
import type { WindowChoice } from './windowAccounts';

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
  /** The avatar colour the user chose (0 to AVATAR_COLOURS - 1); unset means the default. */
  color?: number;
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
/** Written by versions before 0.9; only cleared now. */
const DISMISSED_KEY = 'roster.dismissedIdentities';
const LAST_SWITCH_KEY = 'roster.lastSwitch';
/** The account each window (workspace) chose, by window key. */
const WINDOWS_KEY = 'roster.windowAccounts';
/** A window's choice not used for this long is forgotten, and its login folder goes away. */
const WINDOW_CHOICE_TTL_MS = 30 * 24 * 60 * 60_000;
export const MAX_BACKUPS = 3;
const MAX_WRITE_ATTEMPTS = 3;
/** How long globalState can show an older value after this window writes. See read(). */
const ECHO_SETTLE_MS = 2000;

const credentialsKey = (id: string) => `cred:${id}`;
const accountKey = (id: string) => `acct:${id}`;
const backupKey = (slot: number) => `backup:${slot}`;

export class ProfileStore {
  /** globalState changes, one at a time. See mutate(). */
  private queue: Promise<unknown> = Promise.resolve();
  /** The value this window last wrote per key, and when. See read(). */
  private readonly written = new Map<string, { value: unknown; at: number }>();

  constructor(
    private readonly state: KeyValueStore,
    private readonly secrets: SecretStore,
  ) {}

  list(): ProfileMeta[] {
    return [...(this.read<ProfileMeta[]>(PROFILES_KEY) ?? [])];
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
    try {
      await this.mutate<ProfileMeta[]>(PROFILES_KEY, (profiles = []) => {
        const other = profiles.find((p) => p.identity === meta.identity && p.id !== meta.id);
        if (other) {
          throw new Error(`This account is already saved as "${other.alias}".`);
        }
        return profiles.some((p) => p.id === meta.id) ? profiles : [...profiles, meta];
      });
    } catch (err) {
      await this.deleteLogin(meta.id);
      throw err;
    }
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

  /** Changes the name and avatar colour shown for an account. */
  async edit(id: string, changes: { alias: string; color: number }): Promise<void> {
    await this.patch(id, changes);
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
    await this.deleteLogin(id);
    const isTheirs = (backup: BackupMeta) => backup.fromProfileId === id || backup.identity === meta.identity;
    for (const backup of this.listBackups().filter(isTheirs)) {
      await this.secrets.delete(backupKey(backup.slot));
    }
    await this.mutate<BackupMeta[]>(BACKUPS_KEY, (backups = []) => backups.filter((b) => !isTheirs(b)));
    await this.mutate<Record<string, WindowChoice>>(WINDOWS_KEY, (choices = {}) =>
      Object.fromEntries(Object.entries(choices).filter(([, choice]) => choice.profileId !== id)),
    );
    await this.mutate<ProfileMeta[]>(PROFILES_KEY, (profiles = []) => profiles.filter((p) => p.id !== id));
  }

  /** The account a window chose, while that account is still saved and the choice has not expired. */
  getWindowChoice(windowKey: string, now = Date.now()): WindowChoice | undefined {
    const choice = this.read<Record<string, WindowChoice>>(WINDOWS_KEY)?.[windowKey];
    return choice && now - choice.at < WINDOW_CHOICE_TTL_MS && this.get(choice.profileId) ? choice : undefined;
  }

  /** Records the account a window uses; undefined goes back to the default account. Also drops expired choices. */
  async setWindowChoice(windowKey: string, profileId: string | undefined): Promise<void> {
    const now = Date.now();
    await this.mutate<Record<string, WindowChoice>>(WINDOWS_KEY, (choices = {}) => {
      const kept = Object.entries(choices).filter(([key, choice]) => key !== windowKey && now - choice.at < WINDOW_CHOICE_TTL_MS);
      return Object.fromEntries(profileId ? [...kept, [windowKey, { profileId, at: now }]] : kept);
    });
  }

  /** Accounts that some window chose, within WINDOW_CHOICE_TTL_MS. */
  chosenAccounts(now = Date.now()): Set<string> {
    const choices = Object.values(this.read<Record<string, WindowChoice>>(WINDOWS_KEY) ?? {});
    return new Set(choices.filter((c) => now - c.at < WINDOW_CHOICE_TTL_MS && this.get(c.profileId)).map((c) => c.profileId));
  }

  /** Every window goes back to the default account. */
  async clearWindowChoices(): Promise<void> {
    await this.mutate(WINDOWS_KEY, () => undefined);
  }

  /** Most recent first. */
  listBackups(): BackupMeta[] {
    return [...(this.read<BackupMeta[]>(BACKUPS_KEY) ?? [])];
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
    await this.mutate<BackupMeta[]>(BACKUPS_KEY, (current = []) =>
      current[0] === meta ? current : [meta, ...current.filter((b) => b.slot !== slot)].slice(0, MAX_BACKUPS),
    );
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

  getLastSwitch(): LastSwitch | undefined {
    return this.read<LastSwitch>(LAST_SWITCH_KEY);
  }

  async setLastSwitch(value: LastSwitch | undefined): Promise<void> {
    await this.mutate(LAST_SWITCH_KEY, () => value);
  }

  /** Wipes everything Claude Switch saved. The live Claude login is not touched. */
  async clearAll(): Promise<void> {
    for (const profile of this.list()) {
      await this.deleteLogin(profile.id);
    }
    for (let slot = 0; slot < MAX_BACKUPS; slot++) {
      await this.secrets.delete(backupKey(slot));
    }
    for (const key of [PROFILES_KEY, BACKUPS_KEY, DISMISSED_KEY, LAST_SWITCH_KEY, WINDOWS_KEY]) {
      await this.mutate(key, () => undefined);
    }
  }

  private async writeLogin(id: string, login: SavedLogin): Promise<void> {
    await this.secrets.store(credentialsKey(id), login.credentialsRaw);
    await this.secrets.store(accountKey(id), JSON.stringify(login.account));
  }

  private async deleteLogin(id: string): Promise<void> {
    await this.secrets.delete(credentialsKey(id));
    await this.secrets.delete(accountKey(id));
  }

  private require(id: string): ProfileMeta {
    const meta = this.get(id);
    if (!meta) {
      throw new Error('That account is no longer saved in Claude Switch.');
    }
    return meta;
  }

  private async patch(id: string, changes: Partial<ProfileMeta>): Promise<void> {
    await this.mutate<ProfileMeta[]>(PROFILES_KEY, (profiles = []) => {
      if (!profiles.some((p) => p.id === id)) {
        throw new Error('That account is no longer saved in Claude Switch.');
      }
      return profiles.map((p) => (p.id === id ? { ...p, ...changes } : p));
    });
  }

  /**
   * A globalState value, preferring what this window wrote in the last
   * ECHO_SETTLE_MS. VS Code sends every globalState write back to the
   * extension and replaces its in-memory copy with it, and an older write can
   * come back after a newer one: for a moment, globalState then shows a renamed
   * account under its old name. Other windows' changes still show once that
   * moment has passed.
   */
  private read<T>(key: string): T | undefined {
    const mine = this.written.get(key);
    return mine && Date.now() - mine.at < ECHO_SETTLE_MS ? (mine.value as T | undefined) : this.state.get<T>(key);
  }

  /**
   * Changes one globalState value, one change at a time, and only when it
   * actually changes. change gets the current value and returns the new one.
   * Working from read() rather than globalState itself means an older value
   * coming back cannot undo, say, a rename made a moment earlier.
   */
  private mutate<T>(key: string, change: (current: T | undefined) => T | undefined): Promise<void> {
    const run = this.queue.then(async () => {
      const current = this.read<T>(key);
      const next = change(current);
      if (JSON.stringify(next) === JSON.stringify(current)) {
        return;
      }
      this.written.set(key, { value: next, at: Date.now() });
      try {
        for (let attempt = 1; ; attempt++) {
          await this.state.update(key, next);
          // An older value can land just after ours, from this window or another. Ours is newer.
          if (JSON.stringify(this.state.get<T>(key)) === JSON.stringify(next) || attempt === MAX_WRITE_ATTEMPTS) {
            break;
          }
        }
      } catch (err) {
        this.written.delete(key);
        throw err;
      }
      this.written.set(key, { value: next, at: Date.now() });
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
