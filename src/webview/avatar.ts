/**
 * Avatar helpers shared by the extension and the webview. Pure code: no DOM
 * and no Node APIs.
 */

/** Colours an account can be given; matches the .avatar-N classes in media/switch.css. */
export const AVATAR_COLOURS = 12;

/**
 * Accounts without a chosen colour get one of the first 8, picked from their
 * id. Kept at 8 so adding colours did not change anyone's existing avatar.
 */
export const DEFAULT_AVATAR_COLOURS = 8;

export function isAvatarColour(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < AVATAR_COLOURS;
}

/** "Work" gives "W"; "Acme Team" gives "AT". Works for any script. */
export function initialsOf(alias: string): string {
  const words = alias.trim().split(/\s+/).filter(Boolean);
  const first = (word: string) => Array.from(word)[0] ?? '';
  const letters = words.length > 1 ? first(words[0]) + first(words[1]) : first(words[0] ?? '');
  return letters.toLocaleUpperCase() || '?';
}
