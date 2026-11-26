import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { planOf, readUsageCache, UsageInfo, usageFromUtilization } from './accountDetails';
import {
  accessTokenExpiry,
  assertGlobalConfigWritable,
  atomicWrite,
  ClaudePaths,
  credentialsMatchAccount,
  delay,
  errorCode,
  identityOf,
  LoginSnapshot,
  OAuthAccount,
  readSnapshot,
  readTextIfExists,
  refreshTokenExpiry,
  sameAccount,
  sameSnapshot,
  SavedLogin,
  tokenKey,
  toSavedLogin,
  writeCredentials,
  writeOauthAccount,
} from './claudeFiles';
import { errorMessage, Logger } from './log';
import { BackupMeta, ProfileMeta, ProfileStore } from './profileStore';
import type { LoginFolders } from './windowAccounts';

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
  /**
   * Asks Claude's CLI whose login a folder holds. Claude Code's tokens no longer
   * say, so it is how a login is confirmed before it is saved, when that can't
   * wait for the next usage check: during a switch, or before a folder goes.
   */
  identify?: (loginDir: string) => Promise<OAuthAccount | undefined>;
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

/** What a usage check got from Claude. */
export interface UsageAnswer {
  /** Claude's get_usage rate limits; see usageFromUtilization(). */
  utilization: unknown;
  /** The account Claude found its login to be, if it said; see checkedAccount(). */
  owner?: OAuthAccount;
}

export interface UsageCheckResult {
  /** The check got numbers. */
  updated: boolean;
  /** The account's own login turned out to be this other account's. See ProfileMeta.signedInAs. */
  signedInAs?: string;
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
/** How long a login folder that no window uses is kept after Claude last wrote to it. See reconcileFolders(). */
const FOLDER_IDLE_MS = 24 * 60 * 60_000;
const LOCK_WAIT_MS = 20_000;
const LOCK_RETRY_MS = 150;
/** What Windows reports while another window deletes the lock file. See openExclusive(). */
const BUSY_OPEN_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const OPEN_ATTEMPTS = 5;
const LAST_SWITCH_WINDOW_MS = 10 * 60_000;
/** Where Claude keeps a login's tokens, in whatever folder it is given. */
const CREDENTIALS_FILE = '.credentials.json';
const STABLE_READ_ATTEMPTS = 4;

export class SwitchEngine {
  /**
   * A hash of the live login that syncBack last declined because the saved one
   * is newer. Until the live login changes, refresh() has nothing to do.
   */
  private declinedLive: string | undefined;

  /**
   * Whether Claude Code's usage cache in .claude.json can be trusted. Claude
   * labels it with the default account even when a window's Claude used
   * another account's login, so the controller turns this off while any window
   * has its own account; usage then comes from usage checks alone.
   */
  usageCacheTrusted = true;

  /**
   * Accounts whose login changed where Claude keeps it, to tokens not yet known
   * to be theirs: they are saved once a usage check of the account confirms
   * them. The controller checks these accounts soon.
   */
  readonly unconfirmed = new Set<string>();

  constructor(
    private readonly paths: ClaudePaths,
    private readonly store: ProfileStore,
    private readonly log: Logger,
    private readonly options: EngineOptions,
  ) {}

  /** Reads the live login and matches it to a profile. Never writes. */
  async detect(): Promise<LiveState> {
    try {
      return await this.classify(await this.readStable());
    } catch (err) {
      return { kind: 'error', message: errorMessage(err) };
    }
  }

  /**
   * detect(), plus saving refreshed tokens into the matching profile and updating statuses. folders: the
   * login folders, when windows can have their own account; see repairMixedLogin().
   */
  async refresh(folders?: LoginFolders): Promise<LiveState> {
    let live = await this.detect();
    if (live.kind === 'error' && live.message === MISMATCH_MESSAGE && folders && (await this.repairMixedLogin(folders))) {
      live = await this.detect();
    }
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
      const live = await this.classify(await this.readStable());
      if (live.kind === 'known') {
        await this.syncBack(live, { strict: true, confirm: true });
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
      const owner = await this.knownOwner(login.credentialsRaw);
      if (!credentialsMatchAccount(login.credentialsRaw, login.account) || (owner !== undefined && owner !== identityOf(login.account))) {
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
   * With folders, the account's login folder, if a window used it, gives its
   * newest tokens first and goes once the login is in ~/.claude, all under
   * one lock: a Claude that refreshed the login in between would leave
   * ~/.claude with a refresh token that no longer works.
   */
  async switchTo(profileId: string, options: { replaceLive?: boolean; folders?: LoginFolders } = {}): Promise<SwitchResult> {
    return this.withLock(async () => {
      const profile = this.store.get(profileId);
      if (!profile) {
        throw new Error('That account is no longer saved in Claude Switch.');
      }
      await this.syncFromFolder(profileId, options.folders);
      const target = await this.store.getLogin(profileId);
      if (!target) {
        throw new Error(`The saved login for "${profile.alias}" is missing. Add the account again.`);
      }

      await this.step('read');
      const before = await this.readStable();
      await assertGlobalConfigWritable(this.paths);
      const live = await this.classify(before);
      if (live.kind === 'known' && live.profile.id === profileId && !options.replaceLive) {
        await this.syncBack(live, { confirm: true });
        return { outcome: 'already-active', profile };
      }

      // A login that fails the sync-back checks is skipped, not fatal: the backup below keeps it.
      await this.step('sync-back');
      if (live.kind === 'known') {
        await this.syncBack(live, { confirm: true });
        // Last chance to keep the outgoing account's usage numbers.
        await this.captureUsage(live).catch(() => undefined);
      }

      await this.step('backup');
      const backup = await this.store.pushBackup(before, {
        fromProfileId: live.kind === 'known' ? live.profile.id : undefined,
        toProfileId: profileId,
      });

      await this.applyVerified({ credentialsRaw: target.credentialsRaw, account: target.account }, before);
      await this.dropFolder(profileId, options.folders);
      await this.store.markUsed(profileId);
      await this.store.setLastSwitch({ profileId, at: this.now() });
      this.log.info(`Switched to "${profile.alias}".`);
      return { outcome: 'switched', profile: this.store.get(profileId) ?? profile, backup };
    });
  }

  /**
   * Puts the login from a backup back in place (the most recent one by
   * default). folders: as for switchTo, for the restored account.
   */
  async restoreBackup(slot?: number, folders?: LoginFolders): Promise<{ profile?: ProfileMeta }> {
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
      const live = await this.classify(before);
      if (live.kind === 'known') {
        await this.syncBack(live, { confirm: true });
      }

      // The account may have been used since, in a window's login folder or here, and its
      // refresh token replaced: then the backup's tokens no longer work, and the saved ones do.
      const profile = snapshot.account ? this.store.findByAccount(snapshot.account) : undefined;
      await this.syncFromFolder(profile?.id, folders);
      const saved = profile ? await this.store.getLogin(profile.id) : undefined;
      const restore = saved && snapshot.credentialsRaw && newerLogin(saved.credentialsRaw, snapshot.credentialsRaw) ? { ...snapshot, credentialsRaw: saved.credentialsRaw } : snapshot;
      // A login that isn't a saved account is kept nowhere else; back it up, as a switch does.
      if (live.kind !== 'known' && (before.credentialsRaw !== null || before.account !== null)) {
        await this.step('backup');
        await this.store.pushBackup(before, { toProfileId: profile?.id });
      }
      await this.applyVerified(restore, before);
      if (profile) {
        await this.dropFolder(profile.id, folders);
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
   * Gets an account's current usage from Claude (see usageCheck.ts) and keeps
   * it with that account. Without folderProfileId, the account is the default
   * one in ~/.claude; with it, the account whose login folder Claude was given.
   * Holds the switch lock while Claude runs, so no switch in any window changes
   * the login meanwhile; a switch waits for it. Returns false when there was
   * nothing to check, or the login changed anyway.
   *
   * place: the login folders, for an account other than the default; with
   * lendTo, for one that is neither the default nor has a login folder, a folder
   * of Claude Switch's own that gets its saved login for the check only. Tokens
   * Claude refreshes there are saved back before the lock goes, so the login
   * still lives in one place.
   *
   * Claude also says whose login it was given (UsageAnswer.owner). The numbers
   * then go to that account, and only to it; and a login folder or lent login
   * that turns out to be another account's is flagged (ProfileMeta.signedInAs).
   */
  async checkUsage(ask: () => Promise<UsageAnswer>, folderProfileId?: string, place?: { folders: LoginFolders; lendTo?: string }): Promise<UsageCheckResult> {
    return this.withLock(async () => {
      let profileId = folderProfileId;
      let account: OAuthAccount | undefined;
      if (!profileId) {
        const live = await this.classify(await this.readStable());
        if (live.kind !== 'known') {
          return { updated: false };
        }
        profileId = live.profile.id;
        account = live.login.account;
      }
      const lendTo = place?.lendTo;
      if (lendTo && place && !(await this.canLend(profileId, place.folders))) {
        return { updated: false };
      }
      // Where Claude reads this login, to tell whose tokens Claude was given.
      const file = !folderProfileId ? this.paths.credentialsFile : lendTo ? path.join(lendTo, CREDENTIALS_FILE) : place?.folders.credentialsFile(profileId);
      if (lendTo) {
        await this.lendLogin(profileId, lendTo);
      }
      let answer: UsageAnswer;
      try {
        const before = file && (await readTextIfExists(file));
        answer = await ask();
        if (answer.owner) {
          // Claude may have refreshed the tokens meanwhile: both are that account's.
          await this.rememberOwner([before, file && (await readTextIfExists(file))], answer.owner);
        }
      } finally {
        if (lendTo) {
          await this.takeBackLogin(profileId, lendTo);
        }
      }
      const usage = usageFromUtilization(answer.utilization, this.now());
      const profile = this.store.get(profileId);
      if (!profile) {
        return { updated: false };
      }
      const owner = answer.owner;
      if (owner && identityOf(owner) !== profile.identity) {
        // The numbers are the other account's: kept with it, if it is saved.
        const theirs = this.store.list().find((p) => p.identity === identityOf(owner));
        if (theirs && usage) {
          await this.keepUsage(theirs.id, usage);
        }
        // A login folder, or a lent login, is the account's own login. ~/.claude's mix-ups are refresh()'s to repair.
        if (folderProfileId) {
          await this.flagForeign(profile, owner.emailAddress);
          return { updated: !!theirs && !!usage, signedInAs: owner.emailAddress };
        }
        return { updated: !!theirs && !!usage };
      }
      if (owner) {
        this.unconfirmed.delete(profile.id);
        if (profile.signedInAs) {
          await this.store.setSignedInAs(profile.id, undefined);
        }
        // Confirmed now: save what Claude may have refreshed in its login folder. ~/.claude's, refresh() saves.
        const raw = folderProfileId && !lendTo && file ? await readTextIfExists(file) : undefined;
        if (raw) {
          await this.syncFolder(profile.id, raw);
        }
      }
      // Claude Code's /login could still have changed the default account.
      const unchanged = !account || sameAccount((await readSnapshot(this.paths)).account, account);
      if (!usage || !unchanged) {
        return { updated: false };
      }
      await this.keepUsage(profile.id, usage);
      return { updated: true };
    }, 0);
  }

  /** Keeps usage numbers with an account, unless it already has newer ones. */
  private async keepUsage(profileId: string, usage: UsageInfo): Promise<void> {
    if (usage.fetchedAt > (this.store.get(profileId)?.usage?.fetchedAt ?? 0)) {
      await this.store.setDetails(profileId, { usage });
    }
  }

  /**
   * Whether an account's saved login can be lent to a usage check: only while it
   * is in use nowhere, since a Claude that refreshed it in a second place would
   * sign the first out. Call under the lock: a window may have chosen the
   * account since the caller looked.
   */
  private async canLend(profileId: string, folders: LoginFolders): Promise<boolean> {
    if (folders.has(profileId)) {
      return false;
    }
    const live = await this.classify(await this.readStable());
    return live.kind !== 'error' && !(live.kind === 'known' && live.profile.id === profileId);
  }

  /** Gives a usage check the account's saved login, in a folder of Claude Switch's own. Call under the lock. */
  private async lendLogin(profileId: string, dir: string): Promise<void> {
    const file = path.join(dir, CREDENTIALS_FILE);
    // A check that could not give it back, say because VS Code closed meanwhile, may have left newer tokens.
    const left = await readTextIfExists(file);
    if (left) {
      await this.syncFolder(profileId, left, dir);
    }
    const login = await this.store.getLogin(profileId);
    if (!login) {
      throw new Error(`The saved login for "${this.store.get(profileId)?.alias ?? 'an account'}" is missing.`);
    }
    await fs.mkdir(dir, { recursive: true });
    await atomicWrite(file, login.credentialsRaw);
  }

  /**
   * After a usage check: saves the tokens Claude refreshed in the lent login,
   * then removes it. Confirmed at once if the check did not say whose they are:
   * the lent login is about to go, and refreshed tokens with it.
   */
  private async takeBackLogin(profileId: string, dir: string): Promise<void> {
    const file = path.join(dir, CREDENTIALS_FILE);
    const raw = await readTextIfExists(file);
    if (raw) {
      await this.syncFolder(profileId, raw, dir);
    }
    await fs.rm(file, { force: true });
  }

  /**
   * Keeps each account's login in exactly one place (see windowAccounts.ts):
   * creates the login folders that windows need, and, after saving their newest
   * tokens, removes the default account's folder, whose login lives in
   * ~/.claude, and folders no window has used for FOLDER_IDLE_MS. Background
   * callers skip their turn while another window holds the lock. defaultId is
   * the caller's idea of the default account; under the lock, the login in
   * ~/.claude decides, since it may have changed since the caller looked.
   */
  async reconcileFolders(folders: LoginFolders, defaultId: string | undefined, chosen: Set<string>, background = true): Promise<void> {
    const plan = async (defaultAccount: string | undefined) => {
      const create: { id: string; login: SavedLogin }[] = [];
      for (const id of chosen) {
        const login = id !== defaultAccount && !folders.has(id) ? await this.store.getLogin(id) : undefined;
        if (login) {
          create.push({ id, login });
        }
      }
      const remove: string[] = [];
      for (const id of await folders.list()) {
        if (id !== defaultAccount && chosen.has(id) && this.store.get(id)) {
          continue;
        }
        // A folder that no window uses stays while Claude conversations opened on it may still refresh their login into it.
        const idle = this.now() - ((await folders.modifiedAt(id)) ?? 0) >= FOLDER_IDLE_MS;
        if (id === defaultAccount || !this.store.get(id) || idle) {
          remove.push(id);
        }
      }
      return { create, remove };
    };
    // Usually all is in order; then skip the lock, since this runs on every refresh.
    const first = await plan(defaultId);
    if (first.create.length === 0 && first.remove.length === 0) {
      return;
    }
    await this.withLock(
      async () => {
        // A folder made for the account that is now the default would put its login in two places.
        const live = await this.classify(await this.readStable());
        if (live.kind === 'error') {
          throw new Error(live.message);
        }
        const { create, remove } = await plan(live.kind === 'known' ? live.profile.id : undefined);
        for (const { id, login } of create) {
          await folders.write(id, login.credentialsRaw);
          this.log.info(`Created the login folder for "${this.store.get(id)?.alias ?? id}".`);
        }
        for (const id of remove) {
          const raw = await folders.read(id);
          if (raw && this.store.get(id)) {
            // Its tokens go with the folder: confirmed now, if no check has yet.
            await this.syncFolder(id, raw, folders.dirOf(id));
          }
          await folders.remove(id);
          this.log.info(`Removed the login folder for "${this.store.get(id)?.alias ?? 'a removed account'}".`);
        }
      },
      background ? 0 : undefined,
    );
  }

  /**
   * Saves the tokens Claude refreshed in an account's login folder, with the
   * same checks as for ~/.claude: they are the account's own (see isTheirs),
   * and not older than what is saved. Tokens not known to be its own wait for
   * the next usage check of the account; with confirmIn, the folder they are
   * in, Claude's CLI is asked at once.
   */
  async syncFolder(profileId: string, credentialsRaw: string, confirmIn?: string): Promise<void> {
    const profile = this.store.get(profileId);
    const saved = await this.store.getLogin(profileId);
    if (!profile || !saved || saved.credentialsRaw === credentialsRaw) {
      return;
    }
    let tokens = credentialsRaw;
    try {
      const theirs = await this.isTheirs(profile, saved, credentialsRaw, confirmIn);
      if (theirs === false) {
        const owner = this.store.tokenOwner(tokenKey(credentialsRaw) ?? '');
        if (owner) {
          await this.flagForeign(profile, owner.email);
        } else {
          this.log.warn(`Not saving the login folder of "${profile.alias}": its tokens are another account's.`);
        }
        return;
      }
      if (theirs === undefined) {
        this.unconfirmed.add(profile.id);
        return;
      }
      // Claude may have refreshed them while it was asked.
      tokens = (confirmIn && (await readTextIfExists(path.join(confirmIn, CREDENTIALS_FILE)))) || credentialsRaw;
      const savedExpiry = accessTokenExpiry(saved.credentialsRaw);
      const folderExpiry = accessTokenExpiry(tokens);
      if (savedExpiry !== undefined && folderExpiry !== undefined && folderExpiry < savedExpiry) {
        return;
      }
    } catch {
      // Unreadable tokens are never saved.
      return;
    }
    this.unconfirmed.delete(profile.id);
    await this.store.updateLogin(profileId, { credentialsRaw: tokens, account: saved.account });
    this.log.info(`Saved the refreshed login for "${profile.alias}".`);
  }

  /**
   * Whether tokens are the login of a profile (whose saved login is `saved`):
   * true or false when known, undefined when not. Known are the tokens of a
   * saved login, and those a usage check or identify() found the owner of.
   * Unknown ones are confirmed with Claude's CLI at once when confirmIn, the
   * folder they are in, is given.
   */
  private async isTheirs(profile: ProfileMeta, saved: SavedLogin | undefined, credentialsRaw: string, confirmIn?: string): Promise<boolean | undefined> {
    // Older Claude Code versions name the organization in the tokens: another one is never theirs.
    if (saved && !credentialsMatchAccount(credentialsRaw, saved.account)) {
      return false;
    }
    const owner = (await this.knownOwner(credentialsRaw)) ?? (confirmIn ? await this.confirmOwner(confirmIn) : undefined);
    return owner === undefined ? undefined : owner === profile.identity;
  }

  /**
   * The identity of the account whose tokens these are, if known: as Claude's
   * CLI said at a usage check or identify(), else that of the saved account
   * whose login they are. The CLI comes first: a saved login can itself have
   * become another account's before Claude Switch could tell.
   */
  private async knownOwner(credentialsRaw: string): Promise<string | undefined> {
    const key = tokenKey(credentialsRaw);
    if (!key) {
      return undefined;
    }
    const told = this.store.tokenOwner(key);
    if (told) {
      return told.identity;
    }
    for (const profile of this.store.list()) {
      const login = await this.store.getLogin(profile.id);
      if (login && tokenKey(login.credentialsRaw) === key) {
        return profile.identity;
      }
    }
    return undefined;
  }

  /** Asks Claude's CLI whose login a folder holds, and remembers the answer. Call under the lock. */
  private async confirmOwner(loginDir: string): Promise<string | undefined> {
    if (!this.options.identify) {
      return undefined;
    }
    const file = path.join(loginDir, CREDENTIALS_FILE);
    const before = await readTextIfExists(file);
    const owner = await this.options.identify(loginDir).catch((err: unknown) => {
      this.log.warn(`Could not ask Claude whose login is in ${loginDir}: ${errorMessage(err)}`);
      return undefined;
    });
    if (!owner) {
      return undefined;
    }
    // Claude may have refreshed the tokens meanwhile: both are that account's.
    await this.rememberOwner([before, await readTextIfExists(file)], owner);
    return identityOf(owner);
  }

  private async rememberOwner(logins: (string | undefined)[], owner: OAuthAccount): Promise<void> {
    const keys = logins.map((raw) => raw && tokenKey(raw)).filter((key): key is string => !!key);
    if (keys.length) {
      await this.store.rememberTokenOwner([...new Set(keys)], identityOf(owner), owner.emailAddress);
    }
  }

  /**
   * An account's own login turned out to be another account's, such as one
   * signed in to from a window that uses it. It stops being saved over the
   * account's, and the tab says so, with a way to sign in again.
   */
  private async flagForeign(profile: ProfileMeta, email: string): Promise<void> {
    if (this.store.get(profile.id)?.signedInAs === email) {
      return;
    }
    await this.store.setSignedInAs(profile.id, email);
    this.log.warn(`The login of "${profile.alias}" (${profile.email}) is ${email}'s: windows that use "${profile.alias}" run Claude as ${email}. Sign in to "${profile.alias}" again.`);
  }

  /**
   * Makes an account whose login turned out to be another account's (see
   * ProfileMeta.signedInAs) that other account, keeping its name and colour:
   * for when a sign-in, say after the login expired, picked another account in
   * the browser, and that is the one to keep. Claude's CLI is asked whose the
   * login is now, in the account's login folder, or else in lendTo, a folder of
   * Claude Switch's own that gets the saved login for the question only.
   */
  async keepAsSignedIn(profileId: string, folders: LoginFolders, lendTo: string): Promise<ProfileMeta> {
    return this.withLock(async () => {
      const profile = this.store.get(profileId);
      if (!profile) {
        throw new Error('That account is no longer saved in Claude Switch.');
      }
      const inFolder = folders.has(profileId);
      if (!inFolder && !(await this.canLend(profileId, folders))) {
        throw new Error(`"${profile.alias}" is the default account, which Claude Switch can't change this way. Switch all windows to another account first.`);
      }
      const dir = inFolder ? folders.dirOf(profileId) : lendTo;
      const file = path.join(dir, CREDENTIALS_FILE);
      if (!inFolder) {
        await this.lendLogin(profileId, lendTo);
      }
      let owner: OAuthAccount | undefined;
      let login: string | undefined;
      try {
        owner = await this.options.identify?.(dir).catch(() => undefined);
        // Claude may have refreshed it while it was asked.
        login = await readTextIfExists(file);
      } finally {
        if (!inFolder) {
          await fs.rm(file, { force: true });
        }
      }
      if (!owner || !login) {
        throw new Error(`Claude could not say whose login "${profile.alias}" has. Try again in a moment.`);
      }
      await this.rememberOwner([login], owner);
      if (identityOf(owner) === profile.identity) {
        // Its own after all.
        await this.store.setSignedInAs(profileId, undefined);
      } else {
        await this.adopt(profile, { credentialsRaw: login, account: owner });
      }
      return this.store.get(profileId) ?? profile;
    });
  }

  /**
   * Makes a saved account the account of a login just signed in to, keeping its
   * name and colour; windows that use it get the login. For signing in again to
   * one account when the browser picked another, and that is the one to keep.
   */
  async adoptLogin(profileId: string, login: SavedLogin, folders?: LoginFolders): Promise<ProfileMeta> {
    return this.withLock(async () => {
      const profile = this.store.get(profileId);
      if (!profile) {
        throw new Error('That account is no longer saved in Claude Switch.');
      }
      await this.adopt(profile, login);
      if (folders?.has(profileId)) {
        await folders.write(profileId, login.credentialsRaw);
      }
      return this.store.get(profileId) ?? profile;
    });
  }

  private async adopt(profile: ProfileMeta, login: SavedLogin): Promise<void> {
    await this.store.adopt(profile.id, login);
    this.unconfirmed.delete(profile.id);
    this.log.info(`"${profile.alias}" is now ${login.account.emailAddress}'s account, instead of ${profile.email}'s.`);
  }

  /**
   * ~/.claude holds half of the default account's login next to half of another account's, and every window
   * refuses to switch. Two ways that happens:
   * - Claude in a window with its own account (a login folder, see windowAccounts.ts) uses the shared
   *   ~/.claude.json, and writes its account details there. So does Claude signed in, in such a window, to an
   *   account Claude Switch doesn't know.
   * - A Claude that still runs on an account with a login folder of its own, but outside that folder, such as
   *   one started while that account was the default, or `claude` run outside VS Code, refreshes its tokens
   *   into ~/.claude.
   * Puts the default account's half back: its details, when the tokens are known to be a saved account's that
   * lives in ~/.claude and the details are another's; its tokens, when the tokens are of a saved account with
   * a login folder and the details of a saved account without one. Any other mix-up stays for the user to see.
   * Skips its turn while another window holds the lock.
   */
  private async repairMixedLogin(folders: LoginFolders): Promise<boolean> {
    try {
      return await this.withLock(async () => {
        const live = await this.readStable();
        const login = toSavedLogin(live);
        if (!login) {
          return false;
        }
        const detailsOf = this.store.findByAccount(login.account);
        // Whose the tokens are: as known, else, from tokens that still name their organization, its only saved account.
        const owner = await this.knownOwner(login.credentialsRaw);
        const tokensOf =
          owner !== undefined ? this.store.list().find((p) => p.identity === owner) : (await this.ownerOfTokens(login.credentialsRaw, detailsOf?.id ?? ''))?.profile;
        if (!tokensOf || tokensOf.id === detailsOf?.id) {
          return false;
        }
        const tokensMoved = folders.has(tokensOf.id);
        const detailsMoved = !!detailsOf && folders.has(detailsOf.id);
        if (!tokensMoved && (!detailsOf || detailsMoved)) {
          const tokensLogin = await this.store.getLogin(tokensOf.id);
          if (!tokensLogin) {
            return false;
          }
          await this.applyVerified({ credentialsRaw: login.credentialsRaw, account: tokensLogin.account }, live);
          this.log.info(
            `Put back the account details of "${tokensOf.alias}" in .claude.json, which Claude on ${detailsOf ? `"${detailsOf.alias}"` : login.account.emailAddress} in another window had replaced with its own.`,
          );
          return true;
        }
        const saved = tokensMoved && detailsOf && !detailsMoved ? await this.store.getLogin(detailsOf.id) : undefined;
        if (!detailsOf || !saved || !credentialsMatchAccount(saved.credentialsRaw, login.account)) {
          return false;
        }
        // The stray tokens are kept nowhere else; a backup keeps them, as a switch does.
        await this.store.pushBackup(live, { toProfileId: detailsOf.id });
        await this.applyVerified({ credentialsRaw: saved.credentialsRaw, account: login.account }, live);
        this.log.warn(
          `Put back the login of "${detailsOf.alias}" in ~/.claude, where a Claude still running on "${tokensOf.alias}" had saved its own: one started while "${tokensOf.alias}" was the default account, or \`claude\` run outside VS Code. Close it, or it does this again when it next refreshes its login.`,
        );
        return true;
      }, 0);
    } catch (err) {
      if (!(err instanceof LockBusyError)) {
        this.log.warn(`Could not put back the default login in ~/.claude: ${errorMessage(err)}`);
      }
      return false;
    }
  }

  /**
   * The saved account, other than `except`, whose tokens these are: the one they were saved into, else the
   * only one in their organization.
   */
  private async ownerOfTokens(credentialsRaw: string, except: string): Promise<{ profile: ProfileMeta; login: SavedLogin } | undefined> {
    const sameOrganization: { profile: ProfileMeta; login: SavedLogin }[] = [];
    for (const profile of this.store.list()) {
      const login = profile.id === except ? undefined : await this.store.getLogin(profile.id);
      if (!login || !credentialsMatchAccount(credentialsRaw, login.account)) {
        continue;
      }
      if (login.credentialsRaw === credentialsRaw) {
        return { profile, login };
      }
      sameOrganization.push({ profile, login });
    }
    return sameOrganization.length === 1 ? sameOrganization[0] : undefined;
  }

  /**
   * Saves the tokens in an account's login folder, if it has one, before its
   * login moves: confirmed with Claude's CLI at once if no check has yet, since
   * newer tokens left behind would leave the moved login unable to refresh.
   */
  private async syncFromFolder(profileId: string | undefined, folders: LoginFolders | undefined): Promise<void> {
    const raw = profileId && folders ? await folders.read(profileId) : undefined;
    if (profileId && folders && raw) {
      await this.syncFolder(profileId, raw, folders.dirOf(profileId));
    }
  }

  /**
   * Removes the login folder of an account whose login is now in ~/.claude,
   * after saving its newest tokens. The switch itself is done by then, so a
   * failure is only logged; reconcileFolders tries again.
   */
  private async dropFolder(profileId: string, folders: LoginFolders | undefined): Promise<void> {
    if (!folders?.has(profileId)) {
      return;
    }
    try {
      await this.syncFromFolder(profileId, folders);
      await folders.remove(profileId);
      this.log.info(`Removed the login folder for "${this.store.get(profileId)?.alias ?? profileId}".`);
    } catch (err) {
      this.log.warn(`Could not remove the login folder yet: ${errorMessage(err)}`);
    }
  }

  /** Whether the live login is still `target`'s; repairs it when only oauthAccount changed. Call under the lock. */
  private async checkLive(target: SavedLogin): Promise<'ok' | 'repaired' | 'mismatch'> {
    const live = await this.readStable();
    if (sameAccount(live.account, target.account)) {
      // The right account details next to another account's tokens are a mix-up too.
      return live.credentialsRaw === null || credentialsMatchAccount(live.credentialsRaw, target.account) ? 'ok' : 'mismatch';
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
    if (live.kind !== 'known' || !this.usageCacheTrusted) {
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

  /**
   * Saves the live login into its profile, since Claude refreshes tokens while
   * it runs. Only tokens known to be the profile's own (see isTheirs): with
   * confirm, unknown ones are confirmed with Claude's CLI at once, else they
   * wait for the next usage check. strict (Re-capture) reports what it skips.
   */
  private async syncBack(live: Extract<LiveState, { kind: 'known' }>, options: { strict?: boolean; confirm?: boolean } = {}): Promise<void> {
    const { profile, login } = live;
    const saved = await this.store.getLogin(profile.id);
    if (saved && saved.credentialsRaw === login.credentialsRaw && JSON.stringify(saved.account) === JSON.stringify(login.account)) {
      return;
    }
    const theirs = await this.isTheirs(profile, saved, login.credentialsRaw, options.confirm ? path.dirname(this.paths.credentialsFile) : undefined);
    if (theirs !== true) {
      if (options.strict) {
        throw new Error(theirs === false ? MISMATCH_MESSAGE : "Claude Switch could not confirm with Claude whose login ~/.claude holds. Try again in a moment.");
      }
      if (theirs === false) {
        this.log.warn(`Not saving the live login for "${profile.alias}": its tokens are another account's.`);
      } else {
        this.unconfirmed.add(profile.id);
      }
      return;
    }
    // Claude may have refreshed them while it was asked.
    const tokens = (options.confirm && (await readTextIfExists(this.paths.credentialsFile))) || login.credentialsRaw;
    // A fresh sign-in through Add Account can be newer than what Claude still holds.
    const savedExpiry = saved ? accessTokenExpiry(saved.credentialsRaw) : undefined;
    const liveExpiry = accessTokenExpiry(tokens);
    if (savedExpiry !== undefined && liveExpiry !== undefined && liveExpiry < savedExpiry) {
      // Both still work; say so once, not on every auto-refresh.
      const declined = hashOf(tokens);
      if (options.strict || declined !== this.declinedLive) {
        this.log.info(`Kept the saved login for "${profile.alias}" because it is newer than the live one.`);
      }
      this.declinedLive = declined;
      return;
    }
    this.unconfirmed.delete(profile.id);
    await this.store.updateLogin(profile.id, { credentialsRaw: tokens, account: login.account });
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

  private withCurrentMeta(live: LiveState): LiveState {
    return live.kind === 'known' ? { ...live, profile: this.store.get(live.profile.id) ?? live.profile } : live;
  }

  /**
   * Matches a login to a profile. The tokens decide whose login it is: the
   * account details next to them can be another Claude's, written into the
   * shared ~/.claude.json. Details that disagree with whose the tokens are
   * known to be are a mix-up.
   */
  private async classify(snapshot: LoginSnapshot): Promise<LiveState> {
    const login = toSavedLogin(snapshot);
    if (!login) {
      return { kind: 'signed-out' };
    }
    if (!credentialsMatchAccount(login.credentialsRaw, login.account)) {
      return { kind: 'error', message: MISMATCH_MESSAGE };
    }
    const owner = await this.knownOwner(login.credentialsRaw);
    if (owner !== undefined && owner !== identityOf(login.account)) {
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
      const handle = await openExclusive(file);
      // The pid tells other windows whether the holder still runs; the random part tells this lock from a later one.
      const owner = `${process.pid} ${new Date().toISOString()} ${randomBytes(8).toString('hex')}`;
      try {
        await handle.writeFile(owner);
      } catch (writeErr) {
        await handle.close();
        await fs.rm(file, { force: true });
        throw writeErr;
      }
      await handle.close();
      return async () => {
        // A lock held past LOCK_STALE_MS may have been taken over; that one is another window's to release.
        if ((await readTextIfExists(file).catch(() => undefined)) === owner) {
          await fs.rm(file, { force: true });
        }
      };
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') {
        throw err;
      }
      const stat = await fs.stat(file).catch(() => undefined);
      const theirs = await readTextIfExists(file).catch(() => undefined);
      if (!stat || theirs === undefined) {
        // Released meanwhile. Deleting the file now could delete the lock another window has just taken.
        continue;
      }
      // A window that reloaded or crashed while holding the lock leaves it behind; its process is gone.
      const holder = Number.parseInt(theirs, 10);
      const holderGone = Number.isInteger(holder) && holder !== process.pid && !isRunning(holder);
      if (Date.now() - stat.mtimeMs < staleMs && !holderGone) {
        throw new LockBusyError();
      }
      // Abandoned, unless another window took it over since.
      if ((await readTextIfExists(file).catch(() => undefined)) === theirs) {
        await fs.rm(file, { force: true });
      }
    }
  }
  throw new LockBusyError();
}

/**
 * Creates the lock file, failing with EEXIST if it exists. Windows reports
 * EPERM for a moment while another window deletes it, so that is retried.
 */
async function openExclusive(file: string): Promise<fs.FileHandle> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fs.open(file, 'wx');
    } catch (err) {
      if (!BUSY_OPEN_CODES.has(errorCode(err)) || attempt >= OPEN_ATTEMPTS) {
        throw err;
      }
      await delay(attempt * 20);
    }
  }
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

/** Whether login `a` was issued after login `b`, by when their access tokens expire. */
function newerLogin(a: string, b: string): boolean {
  try {
    const expiryA = accessTokenExpiry(a);
    const expiryB = accessTokenExpiry(b);
    return expiryA !== undefined && expiryB !== undefined && expiryA > expiryB;
  } catch {
    return false;
  }
}
