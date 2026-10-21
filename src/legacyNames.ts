import type { KeyValueStore } from './profileStore';

/**
 * Until 0.14, Claude Switch used its old name, Claude Roster, inside: for its
 * commands, settings, saved data and sign-in folders. This is the only place
 * the old names remain, so that what was saved under them carries over.
 */

const OLD_ID_PREFIX = 'claudeRoster.';
const NEW_ID_PREFIX = 'claudeSwitch.';
const OLD_STATE_PREFIX = 'roster.';

/** The sign-in folders of before 0.14. An Add Account that did not finish may have left one, with tokens in it. */
export const LEGACY_LOGIN_DIR_PREFIX = 'claude-roster-login-';

/** Saved data, by its name after the prefix: in globalState, and in workspaceState. */
const GLOBAL_KEYS = ['profiles', 'backups', 'lastSwitch', 'windowAccounts', 'warnedConfigDir'];
const WORKSPACE_KEYS = ['windowKey'];
/** Written before 0.9 and unused since; dropped, not moved. */
const DROPPED_GLOBAL_KEYS = ['dismissedIdentities'];

const SETTINGS = ['claudePath', 'confirmBeforeSwitch', 'switchMode', 'usageCheckSeconds', 'autoRefreshSeconds'];
/** globalState: the settings have been moved, so old ones left in settings.json no longer count. */
const SETTINGS_MOVED_KEY = `${NEW_ID_PREFIX}settingsMoved`;

/**
 * Moves saved data from the old names to the new ones, leaving data already
 * under the new names as it is. A memento shows an update at once, so what
 * reads it next sees the moved data; the promise is for the writes.
 */
export function moveLegacyState(globalState: KeyValueStore, workspaceState: KeyValueStore): Promise<void> {
  const writes: PromiseLike<void>[] = [];
  const move = (state: KeyValueStore, name: string, keep: boolean) => {
    const oldKey = OLD_STATE_PREFIX + name;
    const value = state.get<unknown>(oldKey);
    if (value === undefined) {
      return;
    }
    if (keep && state.get<unknown>(NEW_ID_PREFIX + name) === undefined) {
      writes.push(state.update(NEW_ID_PREFIX + name, value));
    }
    writes.push(state.update(oldKey, undefined));
  };
  for (const name of GLOBAL_KEYS) {
    move(globalState, name, true);
  }
  for (const name of DROPPED_GLOBAL_KEYS) {
    move(globalState, name, false);
  }
  for (const name of WORKSPACE_KEYS) {
    move(workspaceState, name, true);
  }
  return Promise.all(writes).then(() => undefined);
}

/** User settings; extension.ts passes VS Code's. */
export interface UserSettings {
  get(key: string): unknown;
  set(key: string, value: unknown): PromiseLike<void>;
}

/**
 * Settings made under the old names apply under the new ones, once. VS Code
 * lets no extension remove a setting it no longer declares, so the old
 * entries stay in settings.json, unused. Returns the settings moved.
 */
export async function moveLegacySettings(globalState: KeyValueStore, settings: UserSettings): Promise<string[]> {
  if (globalState.get<boolean>(SETTINGS_MOVED_KEY)) {
    return [];
  }
  const moved: string[] = [];
  for (const name of SETTINGS) {
    const value = settings.get(OLD_ID_PREFIX + name);
    if (value !== undefined && settings.get(NEW_ID_PREFIX + name) === undefined) {
      await settings.set(NEW_ID_PREFIX + name, value);
      moved.push(NEW_ID_PREFIX + name);
    }
  }
  await globalState.update(SETTINGS_MOVED_KEY, true);
  return moved;
}

/** A command's id before 0.14, which keybindings made back then still use. */
export function legacyCommandId(id: string): string {
  return id.startsWith(NEW_ID_PREFIX) ? OLD_ID_PREFIX + id.slice(NEW_ID_PREFIX.length) : id;
}
