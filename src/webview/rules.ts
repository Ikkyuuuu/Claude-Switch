/**
 * Input rules shared by the webview (instant feedback) and the extension
 * (which re-checks every answer, since webview input is untrusted).
 * Pure code: no DOM and no Node APIs.
 */

export const MAX_ALIAS_LENGTH = 40;

export type InputRule = 'alias' | 'email' | 'date' | 'code';

const EMAIL_PATTERN = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

/** Conservative on purpose: the address may reach a command line. */
export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value);
}

/** True for a real calendar date written as YYYY-MM-DD. */
export function isDateString(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const daysInMonth = new Date(year, month, 0).getDate();
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth;
}

export interface CheckOptions {
  /** Aliases already in use, for the alias rule. */
  taken?: string[];
  /** An empty answer is allowed. */
  optional?: boolean;
}

/** The problem with an answer, as a message for the user, or undefined when it is fine. */
export function checkInput(rule: InputRule, raw: string, options: CheckOptions = {}): string | undefined {
  const value = raw.trim();
  if (!value) {
    if (options.optional) {
      return undefined;
    }
    return rule === 'alias' ? 'Enter a name, such as Work or Personal.' : rule === 'code' ? 'Paste the code from the sign-in page.' : 'This is required.';
  }
  switch (rule) {
    case 'alias':
      if (value.length > MAX_ALIAS_LENGTH) {
        return `Use at most ${MAX_ALIAS_LENGTH} characters.`;
      }
      if ((options.taken ?? []).some((name) => name.toLowerCase() === value.toLowerCase())) {
        return 'Another saved account already uses this name.';
      }
      return undefined;
    case 'email':
      return isValidEmail(value) ? undefined : 'Enter a valid email address, or leave it empty.';
    case 'date':
      return isDateString(value) ? undefined : 'Enter a real date as YYYY-MM-DD, for example 2026-11-14.';
    case 'code':
      return value.length > 512 || /[\r\n]/.test(value) ? 'Paste the code exactly as the sign-in page shows it.' : undefined;
  }
}
