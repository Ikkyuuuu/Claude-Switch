import { existsSync, promises as fs, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { atomicWrite, ClaudePaths, identityOf, OAuthAccount, readTextIfExists } from './claudeFiles';

/**
 * Each VS Code window can use its own Claude account.
 *
 * Claude Code reads its login from the folder in CLAUDE_SECURESTORAGE_CONFIG_DIR
 * when that is set; its settings, history and MCP servers stay in ~/.claude.
 * Every extension in a window shares one process environment, and Claude Code
 * passes it on to each claude process it starts. So a window that uses an
 * account other than the one in ~/.claude (the default account) points that
 * variable at the account's own login folder.
 *
 * Each account's login lives in exactly one place: ~/.claude while it is the
 * default account, else its own folder. Claude replaces the refresh token each
 * time it refreshes a login, so two copies of one login would sign each other out.
 */
export const LOGIN_DIR_VARIABLE = 'CLAUDE_SECURESTORAGE_CONFIG_DIR';

const PROFILE_ID = /^[\w-]{1,64}$/;

/** The login folders, one per account that a window uses while it is not the default. */
export class LoginFolders {
  /** root: a folder of Claude Switch's own; nothing else is ever written or deleted. */
  constructor(readonly root: string) {}

  dirOf(profileId: string): string {
    if (!PROFILE_ID.test(profileId)) {
      throw new Error('Not a valid account id.');
    }
    return path.join(this.root, profileId);
  }

  credentialsFile(profileId: string): string {
    return path.join(this.dirOf(profileId), '.credentials.json');
  }

  has(profileId: string): boolean {
    return existsSync(this.credentialsFile(profileId));
  }

  read(profileId: string): Promise<string | undefined> {
    return readTextIfExists(this.credentialsFile(profileId));
  }

  async write(profileId: string, credentialsRaw: string): Promise<void> {
    await fs.mkdir(this.dirOf(profileId), { recursive: true });
    await atomicWrite(this.credentialsFile(profileId), credentialsRaw);
  }

  /** When Claude, or Claude Switch, last wrote the login; undefined if there is none. */
  async modifiedAt(profileId: string): Promise<number | undefined> {
    try {
      return (await fs.stat(this.credentialsFile(profileId))).mtimeMs;
    } catch {
      return undefined;
    }
  }

  async remove(profileId: string): Promise<void> {
    // Windows reports a folder busy for a moment while a process still has a file in it open.
    await fs.rm(this.dirOf(profileId), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  /** Accounts that have a login folder. */
  async list(): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.root);
    } catch {
      return [];
    }
    return names.filter((name) => PROFILE_ID.test(name) && existsSync(path.join(this.root, name, '.credentials.json')));
  }
}

/** A window's chosen account, as kept in globalState by ProfileStore. */
export interface WindowChoice {
  profileId: string;
  /** When the window last used it, epoch ms. */
  at: number;
}

/**
 * Decides, before Claude Code starts anything, which login folder this window
 * uses: synchronous, and from data already on disk. undefined means the
 * default login in ~/.claude. The controller checks again once it has
 * started, and creates a missing folder.
 */
export function startupLoginDir(input: {
  choice: WindowChoice | undefined;
  /** The saved accounts' identity hashes, by id. */
  identities: Map<string, string>;
  paths: ClaudePaths;
  folders: LoginFolders;
}): string | undefined {
  const { choice, identities, paths, folders } = input;
  const identity = choice && identities.get(choice.profileId);
  if (!choice || !identity || identity === defaultIdentitySync(paths) || !folders.has(choice.profileId)) {
    return undefined;
  }
  return folders.dirOf(choice.profileId);
}

/** The identity of the login in ~/.claude, read synchronously; undefined if unreadable. */
function defaultIdentitySync(paths: ClaudePaths): string | undefined {
  try {
    const account = (JSON.parse(readFileSync(paths.globalConfigFile, 'utf8')) as { oauthAccount?: OAuthAccount }).oauthAccount;
    return account && typeof account.accountUuid === 'string' ? identityOf(account) : undefined;
  } catch {
    return undefined;
  }
}
