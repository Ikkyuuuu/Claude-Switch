import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { planOf, readUsageCache, usageFromUtilization } from './accountDetails';
import {
  accessTokenExpiry,
  assertGlobalConfigWritable,
  ClaudePaths,
  credentialsMatchAccount,
  delay,
  errorCode,
  identityOf,
  LoginSnapshot,
  readSnapshot,
  readTextIfExists,
  refreshTokenExpiry,
  sameAccount,
  sameSnapshot,
  SavedLogin,
  toSavedLogin,
  writeCredentials,
  writeOauthAccount,
} from './claudeFiles';
import { errorMessage, Logger } from './log';
import { BackupMeta, ProfileMeta, ProfileStore } from './profileStore';

export type Step = 'read' | 'sync-back' | 'backup' | 'apply-credentials' | 'apply-account' | 'validate';

export interface EngineOptions {
  /** Lock file shared by every VS Code window, so only one switch runs at a time. */
  lockFile: string;
  /** Pause between the two reads that confirm Claude is not mid-write. */
  settleMs?: number;
  /** Test hook called before each step; throwing simulates a failure at that step. */
  onStep?: (step: Step) => void | Promise<void>;
  now?: () => number;
  /**
   * How long a switch waits for another window's switch, or a usage check, to
   * finish before giving up. Defaults to LOCK_WAIT_MS.
   */
  lockWaitMs?: number;
}

export type LiveState =
  | { kind: 'signed-out' }
  | { kind: 'known'; login: SavedLogin; profile: ProfileMeta }
  | { kind: 'unknown'; login: SavedLogin }
  | { kind: 'error'; message: string };

export interface SwitchResult {
  outcome: 'switched' | 'already-active';
  profile: ProfileMeta;
  backup?: BackupMeta;
}

export type LastSwitchCheck =
  | { outcome: 'none' | 'ok' | 'repaired' }
  | { outcome: 'mismatch'; profile: ProfileMeta };

/** The switch failed. rolledBack tells whether the previous login is back in place. */
export class SwitchError extends Error {
  override name = 'SwitchError';
  constructor(
    message: string,
    readonly rolledBack: boolean,
  ) {
    super(message);
  }
}

export class LockBusyError extends Error {
  override name = 'LockBusyError';
  constructor() {
    super('Another VS Code window is switching Claude accounts. Try again in a moment.');
  }
}

const LOCK_STALE_MS = 2 * 60_000;
const LOCK_WAIT_MS = 20_000;
const LOCK_RETRY_MS = 150;
const LAST_SWITCH_WINDOW_MS = 10 * 60_000;
const STABLE_READ_ATTEMPTS = 4;

export class SwitchEngine {
  /**
   * A hash of the live login that syncBack last declined because the saved one
   * is newer. Until the live login changes, refresh() has nothing to do.
   */
  private declinedLive: string | undefined;

  constructor(
    private readonly paths: ClaudePaths,
    private readonly store: ProfileStore,
    private readonly log: Logger,
    private readonly options: EngineOptions,
  ) {}

  /** Reads the live login and matches it to a profile. Never writes. */
  async detect(): Promise<LiveState> {
    try {
      return this.classify(await this.readStable());
    } catch (err) {
      return { kind: 'error', message: errorMessage(err) };
    }
  }

  /** detect(), plus saving refreshed tokens into the matching profile and updating statuses. */
  async refresh(): Promise<LiveState> {
    const live = await this.detect();
    // Usually nothing changed; then skip the lock, since auto-refresh runs every few seconds.
    if (live.kind === 'known' && hashOf(live.login.credentialsRaw) !== this.declinedLive && (await this.differsFromSaved(live))) {
      try {
        await this.withLock(() => this.syncBack(live), 0);
      } catch (err) {
        if (!(err instanceof LockBusyError)) {
          this.log.warn(`Could not save the refreshed login: ${errorMessage(err)}`);
        }
      }
    }
    await this.updateProfiles(live);
    return this.withCurrentMeta(live);
  }

  /** Re-capture Current Login: like refresh(), but reports failures instead of skipping. */
  async recapture(): Promise<LiveState> {
    return this.withLock(async () => {
      const live = this.classify(await this.readStable());
      if (live.kind === 'known') {
        await this.syncBack(live, true);
      }
      await this.updateProfiles(live);
      return this.withCurrentMeta(live);
    });
  }

  /** Saves the live login as a new profile, if it is still the account the user was shown. */
  async saveCurrent(alias: string, expectedIdentity?: string): Promise<ProfileMeta> {
    return this.withLock(async () => {
      const login = toSavedLogin(await this.readStable());
      if (!login) {
        throw new Error('Claude is not signed in, so there is no login to save.');
      }
      if (expectedIdentity && identityOf(login.account) !== expectedIdentity) {
        throw new Error('Claude signed in to a different account in the meantime. Try again.');
      }
      if (!credentialsMatchAccount(login.credentialsRaw, login.account)) {
        throw new Error(MISMATCH_MESSAGE);
      }
      const profile = await this.store.add(alias, login);
      this.log.info(`Saved the current login as "${profile.alias}".`);
      return profile;
    });
  }

  /**
   * replaceLive applies the saved login even when the live login is the same
   * account, which is how a fresh sign-in replaces an expired active login.
   */
  async switchTo(profileId: string, options: { replaceLive?: boolean } = {}): Promise<SwitchResult> {
    return this.withLock(async () => {
      const profile = this.store.get(profileId);
      if (!profile) {
        throw new Error('That account is no longer saved in Claude Switch.');
      }
      const target = await this.store.getLogin(profileId);
      if (!target) {
        throw new Error(`The saved login for "${profile.alias}" is missing. Add the account again.`);
      }

      await this.step('read');
      const before = await this.readStable();
      await assertGlobalConfigWritable(this.paths);
      const live = this.classify(before);
      if (live.kind === 'known' && live.profile.id === profileId && !options.replaceLive) {
        await this.syncBack(live);
        return { outcome: 'already-active', profile };
      }

      // A login that fails the sync-back checks is skipped, not fatal: the backup below keeps it.
      await this.step('sync-back');
      if (live.kind === 'known') {
        await this.syncBack(live);
        // Last chance to keep the outgoing account's usage numbers.
        await this.captureUsage(live).catch(() => undefined);
      }

      await this.step('backup');
      const backup = await this.store.pushBackup(before, {
        fromProfileId: live.kind === 'known' ? live.profile.id : undefined,
        toProfileId: profileId,
      });

      await this.applyVerified({ credentialsRaw: target.credentialsRaw, account: target.account }, before);
      await this.store.markUsed(profileId);
      await this.store.setLastSwitch({ profileId, at: this.now() });
      this.log.info(`Switched to "${profile.alias}".`);
      return { outcome: 'switched', profile: this.store.get(profileId) ?? profile, backup };
    });
  }

  /** Puts the login from a backup back in place (the most recent one by default). */
  async restoreBackup(slot?: number): Promise<{ profile?: ProfileMeta }> {
    return this.withLock(async () => {
      const backups = this.store.listBackups();
      const meta = slot === undefined ? backups[0] : backups.find((b) => b.slot === slot);
      if (!meta) {
        throw new Error('There is no backup to restore.');
      }
      const snapshot = await this.store.getBackup(meta.slot);
      if (!snapshot) {
        throw new Error('The backup data is missing.');
      }

      await this.step('read');
      const before = await this.readStable();
      await assertGlobalConfigWritable(this.paths);
      await this.step('sync-back');
      const live = this.classify(before);
      if (live.kind === 'known') {
        await this.syncBack(live);
      }

      await this.applyVerified(snapshot, before);
      const profile = snapshot.account ? this.store.findByAccount(snapshot.account) : undefined;
      if (profile) {
        await this.store.markUsed(profile.id);
        await this.store.setLastSwitch({ profileId: profile.id, at: this.now() });
      }
      this.log.info(`Restored the backup from ${meta.at}.`);
      return { profile };
    });
  }

  /**
   * Runs once after a reload. The Claude process from before the reload can
   * write its in-memory .claude.json on exit, putting the old oauthAccount back
   * next to the new tokens. Repair that, or report that the switch did not stick.
   */
  async verifyLastSwitch(): Promise<LastSwitchCheck> {
    const last = this.store.getLastSwitch();
    if (!last) {
      return { outcome: 'none' };
    }
    await this.store.setLastSwitch(undefined);
    const profile = this.store.get(last.profileId);
    if (!profile || this.now() - last.at > LAST_SWITCH_WINDOW_MS) {
      return { outcome: 'none' };
    }
    const target = await this.store.getLogin(profile.id);
    if (!target) {
      return { outcome: 'none' };
    }
    return this.withLock(async () => {
      const outcome = await this.checkLive(target);
      if (outcome === 'repaired') {
        this.log.warn(`Repaired oauthAccount for "${profile.alias}" after it was overwritten during reload.`);
      } else if (outcome === 'mismatch') {
        this.log.warn(`The switch to "${profile.alias}" did not stick; another process changed the login.`);
        return { outcome, profile };
      }
      return { outcome };
    });
  }

  /**
   * After a switch without a reload, Claude conversations that were already
   * open keep running, and can write their in-memory .claude.json, with the
   * old oauthAccount, next to the new tokens. Puts the profile's back.
   */
  async keepSwitch(profileId: string): Promise<'ok' | 'repaired' | 'mismatch' | 'none'> {
    const profile = this.store.get(profileId);
    const target = profile && (await this.store.getLogin(profile.id));
    if (!profile || !target) {
      return 'none';
    }
    return this.withLock(async () => {
      const outcome = await this.checkLive(target);
      if (outcome === 'repaired') {
        this.log.warn(`Put back oauthAccount for "${profile.alias}": a Claude conversation opened before the switch had rewritten it.`);
      }
      return outcome;
    });
  }

  /**
   * Gets the live account's current usage from Claude (see usageCheck.ts) and
   * keeps it with that account. Holds the switch lock while Claude runs, so no
   * switch in any window changes the login meanwhile; a switch waits for it.
   * Returns false when there was nothing to check, or the login changed anyway.
   */
  async checkUsage(ask: () => Promise<unknown>): Promise<boolean> {
    return this.withLock(async () => {
      const live = this.classify(await this.readStable());
      if (live.kind !== 'known') {
        return false;
      }
      const usage = usageFromUtilization(await ask(), this.now());
      // Claude Code's /login could still have changed the account.
      const after = await readSnapshot(this.paths);
      const profile = this.store.get(live.profile.id);
      if (!usage || !profile || !sameAccount(after.account, live.login.account)) {
        return false;
      }
      if (usage.fetchedAt > (profile.usage?.fetchedAt ?? 0)) {
        await this.store.setDetails(profile.id, { usage });
      }
      return true;
    }, 0);
  }

  /** Whether the live login is still `target`'s; repairs it when only oauthAccount changed. Call under the lock. */
  private async checkLive(target: SavedLogin): Promise<'ok' | 'repaired' | 'mismatch'> {
    const live = await this.readStable();
    if (sameAccount(live.account, target.account)) {
      return 'ok';
    }
    if (live.credentialsRaw === target.credentialsRaw) {
      await this.applyVerified(target, live);
      return 'repaired';
    }
    return 'mismatch';
  }

  /**
   * Updates what each profile shows: needs-relogin once its refresh token has
   * expired, its plan, and, for the live account, Claude Code's cached usage.
   */
  async updateProfiles(live: LiveState): Promise<void> {
    const now = this.now();
    for (const profile of this.store.list()) {
      const login = live.kind === 'known' && live.profile.id === profile.id ? live.login : await this.store.getLogin(profile.id);
      let expired = !login;
      if (login) {
        try {
          const expiry = refreshTokenExpiry(login.credentialsRaw);
          expired = expiry !== undefined && expiry <= now;
        } catch {
          expired = true;
        }
      }
      const status = expired ? 'needs-relogin' : 'ok';
      if (profile.status !== status) {
        await this.store.setStatus(profile.id, status);
        this.log.info(`"${profile.alias}" is now ${status}.`);
      }
      const plan = login ? planOf(login) : undefined;
      if (plan && JSON.stringify(plan) !== JSON.stringify(profile.plan)) {
        await this.store.setDetails(profile.id, { plan });
      }
    }
    await this.captureUsage(live);
  }

  /** Keeps Claude Code's cached /usage numbers with the account they belong to. */
  private async captureUsage(live: LiveState): Promise<void> {
    if (live.kind !== 'known') {
      return;
    }
    const cache = await readUsageCache(this.paths);
    const profile = this.store.get(live.profile.id);
    if (!cache || !profile || cache.accountUuid !== live.login.account.accountUuid) {
      return;
    }
    // A cache from before the switch can belong to the same person in another organization.
    const switchedAt = profile.lastUsedAt ? Date.parse(profile.lastUsedAt) : 0;
    if (cache.fetchedAt < switchedAt || cache.fetchedAt <= (profile.usage?.fetchedAt ?? 0)) {
      return;
    }
    const { fetchedAt, session, weekly, weeklyOpus, weeklySonnet } = cache;
    await this.store.setDetails(profile.id, { usage: { fetchedAt, session, weekly, weeklyOpus, weeklySonnet } });
  }

  /** Writes the next login, checks it, and puts the previous one back on any failure. */
  private async applyVerified(next: LoginSnapshot, previous: LoginSnapshot): Promise<void> {
    try {
      await this.step('apply-credentials');
      await writeCredentials(this.paths, next.credentialsRaw);
      await this.step('apply-account');
      await writeOauthAccount(this.paths, next.account);
      await this.step('validate');
      const after = await readSnapshot(this.paths);
      if (!sameSnapshot(after, next)) {
        throw new Error('The login files did not match what was written.');
      }
    } catch (err) {
      const reason = errorMessage(err);
      this.log.warn(`Applying the login failed (${reason}). Rolling back.`);
      try {
        await writeCredentials(this.paths, previous.credentialsRaw);
        await writeOauthAccount(this.paths, previous.account);
        if (!sameSnapshot(await readSnapshot(this.paths), previous)) {
          throw new Error('The restored files did not match the backup.');
        }
      } catch (rollbackErr) {
        this.log.error(`Rollback failed: ${errorMessage(rollbackErr)}`);
        throw new SwitchError(
          `Switching failed and the automatic rollback did not finish. Run "Claude Switch: Restore Last Backup". (${reason})`,
          false,
        );
      }
      this.log.info('Rollback complete; the previous login is back in place.');
      throw new SwitchError(`Switching failed, so your previous login was restored. (${reason})`, true);
    }
  }

  /** Saves the live login into its profile, since Claude refreshes tokens while it runs. */
  private async syncBack(live: Extract<LiveState, { kind: 'known' }>, strict = false): Promise<void> {
    const { profile, login } = live;
    if (!credentialsMatchAccount(login.credentialsRaw, login.account)) {
      if (strict) {
        throw new Error(MISMATCH_MESSAGE);
      }
      this.log.warn(`Not saving the live login for "${profile.alias}": its tokens and account do not match.`);
      return;
    }
    if (await this.belongsToAnotherProfile(profile.id, login.credentialsRaw)) {
      if (strict) {
        throw new Error(MISMATCH_MESSAGE);
      }
      this.log.warn(`Not saving the live login for "${profile.alias}": its tokens are another profile's.`);
      return;
    }
    const saved = await this.store.getLogin(profile.id);
    if (saved && saved.credentialsRaw === login.credentialsRaw && JSON.stringify(saved.account) === JSON.stringify(login.account)) {
      return;
    }
    // A fresh sign-in through Add Account can be newer than what Claude still holds.
    const savedExpiry = saved ? accessTokenExpiry(saved.credentialsRaw) : undefined;
    const liveExpiry = accessTokenExpiry(login.credentialsRaw);
    if (savedExpiry !== undefined && liveExpiry !== undefined && liveExpiry < savedExpiry) {
      // Both still work; say so once, not on every auto-refresh.
      const declined = hashOf(login.credentialsRaw);
      if (strict || declined !== this.declinedLive) {
        this.log.info(`Kept the saved login for "${profile.alias}" because it is newer than the live one.`);
      }
      this.declinedLive = declined;
      return;
    }
    await this.store.updateLogin(profile.id, login);
    this.log.info(`Saved the refreshed login for "${profile.alias}".`);
  }

  private async differsFromSaved(live: Extract<LiveState, { kind: 'known' }>): Promise<boolean> {
    const saved = await this.store.getLogin(live.profile.id);
    return (
      !saved ||
      saved.credentialsRaw !== live.login.credentialsRaw ||
      JSON.stringify(saved.account) !== JSON.stringify(live.login.account)
    );
  }

  private async belongsToAnotherProfile(profileId: string, credentialsRaw: string): Promise<boolean> {
    for (const other of this.store.list()) {
      if (other.id !== profileId && (await this.store.getLogin(other.id))?.credentialsRaw === credentialsRaw) {
        return true;
      }
    }
    return false;
  }

  private withCurrentMeta(live: LiveState): LiveState {
    return live.kind === 'known' ? { ...live, profile: this.store.get(live.profile.id) ?? live.profile } : live;
  }

  private classify(snapshot: LoginSnapshot): LiveState {
    const login = toSavedLogin(snapshot);
    if (!login) {
      return { kind: 'signed-out' };
    }
    if (!credentialsMatchAccount(login.credentialsRaw, login.account)) {
      return { kind: 'error', message: MISMATCH_MESSAGE };
    }
    const profile = this.store.findByAccount(login.account);
    return profile ? { kind: 'known', login, profile } : { kind: 'unknown', login };
  }

  /** Reads until two reads agree, so a half-finished sign-in is never captured. */
  private async readStable(): Promise<LoginSnapshot> {
    const settleMs = this.options.settleMs ?? 400;
    let previous = await readSnapshot(this.paths);
    for (let attempt = 0; attempt < STABLE_READ_ATTEMPTS; attempt++) {
      await delay(settleMs);
      const current = await readSnapshot(this.paths);
      if (sameSnapshot(previous, current)) {
        return current;
      }
      previous = current;
    }
    throw new Error("Claude's login files keep changing, perhaps because a sign-in is in progress. Try again in a moment.");
  }

  /** Background work passes waitMs 0, so it skips its turn rather than queueing. */
  private async withLock<T>(fn: () => Promise<T>, waitMs = this.options.lockWaitMs ?? LOCK_WAIT_MS): Promise<T> {
    const release = await acquireLock(this.options.lockFile, LOCK_STALE_MS, waitMs);
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  private async step(step: Step): Promise<void> {
    await this.options.onStep?.(step);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

const MISMATCH_MESSAGE =
  "Claude's tokens and account info don't match, which usually means another VS Code window or a running claude session wrote back an old login. Reload the other windows, then sign in again if needed.";

/**
 * Creates the lock file exclusively, waiting up to waitMs while another holds
 * it; a lock older than LOCK_STALE_MS is treated as abandoned.
 */
export async function acquireLock(file: string, staleMs = LOCK_STALE_MS, waitMs = 0): Promise<() => Promise<void>> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return await tryLock(file, staleMs);
    } catch (err) {
      if (!(err instanceof LockBusyError) || Date.now() >= deadline) {
        throw err;
      }
      await delay(LOCK_RETRY_MS);
    }
  }
}

async function tryLock(file: string, staleMs: number): Promise<() => Promise<void>> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file, 'wx');
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}`);
      await handle.close();
      return async () => {
        await fs.rm(file, { force: true });
      };
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') {
        throw err;
      }
      const stat = await fs.stat(file).catch(() => undefined);
      // A window that reloaded or crashed while holding the lock leaves it behind; its process is gone.
      const holder = Number.parseInt((await readTextIfExists(file).catch(() => undefined)) ?? '', 10);
      const holderGone = Number.isInteger(holder) && holder !== process.pid && !isRunning(holder);
      if (stat && Date.now() - stat.mtimeMs < staleMs && !holderGone) {
        throw new LockBusyError();
      }
      await fs.rm(file, { force: true });
    }
  }
  throw new LockBusyError();
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, but belongs to someone else.
    return errorCode(err) === 'EPERM';
  }
}

/** For remembering a login without keeping its tokens around. */
function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
