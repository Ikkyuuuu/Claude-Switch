# Changelog

## 0.8.3

- README: added an Install section with a screenshot of the Extensions view, and a screenshot of the sign-in card.

## 0.8.2

- Fixed the layout in narrow sidebars. The sign-in card's Submit button no longer sticks out of the card; it moves under the code box when there isn't room. Long email addresses are shortened or wrapped instead of widening the cards. Checked at widths from 220 to 600 pixels.

## 0.8.1

- README: added a screenshot of the Claude Switch tab.

## 0.8.0

- First Marketplace release, published as `wattanun42.claude-switch-accounts` under the MIT license.
- Renamed to **Claude Switch** (unofficial). The tab, commands ("Claude Switch: Switch Account"), status bar, Output channel and messages all use the new name. Settings and saved accounts are unchanged.

## 0.7.1

- The log link is now a full-width **Activity log** button. It shows the entry count, plus a yellow or red dot for warnings or errors you haven't seen.
- Redesigned log page:
  - the entry count and start time in the header
  - filter chips (All, Info, Warnings, Errors) with counts
  - entries grouped by day on a timeline with coloured dots
  - account names in bold, and times shown as "7:06 PM · 1 minute ago"
  - a friendlier empty state

## 0.7.0

- Auto-refresh: while the window is focused, the tab and status bar re-read the login and Claude Code's usage numbers every 10 seconds. Change the interval with `claudeRoster.autoRefreshSeconds`, or set it to `0` to turn it off. These are local file reads only, and the view redraws only when something changed.
- Removed text the tab didn't need:
  - the "Unofficial" badge and the footer disclaimer
  - the "Restore last backup" link (the command is still in the Command Palette and the ⋯ menu)
  - "via Claude Code"
  - the sign-in card's long hint
  - the log page's description and duplicate "Back" link

## 0.6.0

- **Show Log** now opens an activity log page in the Claude Roster tab instead of the Output panel. Entries are newest first, with info, warning and error markers, plus **Copy**, **Clear** and **Open in Output panel** buttons. The command, the footer link and the "Show Log" buttons on error messages all open it.
- Facebook blue replaces the multi-colour gradient: in the accents, the active account's outline, plan badges, sign-in steps and the logo. Dark themes use Facebook's lighter dark-mode blue.
- Usage bars are blue, then yellow when nearly full (75%) and red when almost full (90%).

## 0.5.2

- Each account under "Switch to" is now a card with its own background and border. The border lights up on hover and is amber for accounts whose sign-in has expired.
- Hover buttons sit beside the account name, so they no longer cover the usage lines.

## 0.5.1

- Accounts under "Switch to" now show every limit (session and weekly) with its reset time, how old the numbers are, and the renewal date. Before, they showed only the weekly percentage.

## 0.5.0

- Usage meters on the active account for the 5-hour session and weekly limits, with reset times. They come from Claude Code's own `/usage` cache, with no network calls.
- Other accounts show their usage from when they were last active.
- Each account shows its plan (Pro, Max 20x, Team and so on) and its renewal date. The date is estimated for Pro and Max, shows "Billed by your organization" for Team and Enterprise, and you can set the exact date with **Set date**. A **Billing** link opens the claude.ai billing page.
- The status bar tooltip shows the active account's usage.
- The view now fades in only when it first opens, and refreshes relative times every minute.

## 0.4.0

- Redesigned the Claude Roster tab as a custom view:
  - A welcome page with an **Add account** button.
  - The active account in a highlighted card, and other accounts with coloured avatars and one-click switching.
  - A step-by-step sign-in card with a box for pasting the code.
  - Banners for reloads and errors.
- New logo, extension icon and activity bar icon.
- Right-click an account in the view to rename or remove it.

## 0.3.0

- Add Account signs in through your browser instead of a terminal. It runs `claude auth login` in the background, and the Claude Roster tab offers to open or copy the sign-in link, paste a code, or cancel.
- Signing in again to an expired account pre-fills its email.
- The `claudeRoster.claudeCommand` setting is replaced by `claudeRoster.claudePath`. By default, Roster uses the CLI bundled with the Claude Code extension.

## 0.2.0

- New Claude Roster tab in the activity bar. Click an account to switch to it, or hover for buttons to switch, rename or remove it.
- The tab shows a badge when an account needs a new sign-in or the window needs a reload.
- New commands: Save Current Login and Refresh.

## 0.1.0

- First version: switch, add, rename and remove accounts, re-capture the current login, restore the last backup, and remove all saved data.
- Status bar shows the active account and flags expired logins.
- Switches validate the result and roll back on any failure. Other windows are prompted to reload.
