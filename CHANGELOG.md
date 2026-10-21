# Changelog

## 0.11.1

Bug fixes and polish.

- Fixed: while the default login could not be read for a moment, Claude Switch could give the default account a login folder too, so the same login was in two places and one copy could sign the other out.
- Fixed: Restore Last Backup put back the backup's tokens even when the account had been used since and its refresh token replaced, which signed out windows on the default account. It now restores the newest tokens.
- Fixed: signing in again to an account that a window uses with its own login folder left that folder on the old, possibly expired, login.
- Fixed: an instant switch removed the login folder that the window's open conversations still used, so a token they refreshed could be lost. A folder that no window uses now stays a day.
- Fixed: "Switch again" after a Switch All Windows that did not stick switched only the current window.
- Fixed: a change of the default account in another window asked windows with their own account to reload. Windows whose login did move now ask to reload in every switch mode.
- Fixed: Switch All Windows could report a failure after the switch itself had worked.
- Fixed: with `CLAUDE_SECURESTORAGE_CONFIG_DIR` set by you, switching changed a login file Claude does not read. It now switches the login in that folder.
- Fixed: a window's account choice older than 30 days came back after a restart and switched the window a few seconds later.
- Fixed: after a failed sign-in, Add account did nothing until the error was dismissed.
- Fixed: errors from clicks in the tab, such as saving an edit to an account another window had just removed, went unreported. They now show in the tab.
- Fixed: usage checks only ran as often as auto-refresh; they now follow `claudeRoster.usageCheckSeconds` on their own.
- Fixed: the loading screen could stay up if a reload was cancelled. The status bar's Reload button now restarts extensions only, in that mode.
- Keyboard and screen readers: focus stays where it was when the tab updates and returns after a dialog closes; notices are read out once; each account row has a proper button, with Edit and Remove beside it.
- An expired account shows **Sign in again** instead of suggesting `/login`, which in a window with its own account would mix up the shared account details.
- "Last used" now counts switching a single window.
- Clearer wording: the note under this window's account for every kind of default login, Restore Last Backup, the reload banner, settings descriptions, and a new Troubleshooting section in the README.
- The status bar says Claude Switch is loading until the first check is done, and a loading screen that takes long suggests what to do.
- The Accounts view has an icon, for when it is moved to another part of VS Code.
- README: a Highlights section, and new pictures of the tab, two windows on different accounts, the Edit account dialog, the loading screen and the sign-in card.

## 0.11.0

- **Each VS Code window can use its own Claude account.** Clicking an account switches only the window you are in; other windows keep theirs. Each workspace remembers its account. Claude Code in that window, and its terminals, read the account's login from a folder of its own (through `CLAUDE_SECURESTORAGE_CONFIG_DIR`), while settings, history and MCP servers stay shared in `~/.claude`.
- Each login lives in exactly one place, so two copies can never sign each other out: the default account's in `~/.claude`, every other account's that a window uses in its own folder, which goes away when no window uses it.
- New **Switch All Windows** (right-click an account, or the **⋯** menu): the old behaviour, which changes the default login in `~/.claude` and puts every window back on it.
- The tab's top section is now **This window**, and says which account other windows use by default when this window has its own.
- Usage checks run with a settings folder of their own per account, so each window shows its own account's numbers; Claude Code's shared usage cache is ignored while windows use different accounts, because Claude labels it with the default account.
- Claude Switch now starts with VS Code, before Claude Code, so a window's Claude starts on the window's account.
- Add Account and its terminal fallback ignore the window's login folder, so a new sign-in never lands in it.
- A loading screen while VS Code starts or the window reloads after a switch: a spinner in the middle of the tab, with what is happening below it, such as "Switching to Work…". The tab no longer shows the previous account until the extension catches up, or "signed out" for a moment.
- Fixed: in a narrow sidebar, an estimated renewal date's "estimated" tag could stick out of the card.

## 0.10.1

Bug fixes.

- Fixed: an account's new name or colour could be lost, or take a while to show, when it was saved while Claude Switch was updating usage in the background. Saved data is now written one change at a time and checked afterwards, and nothing is written when nothing changed.
- Fixed: a window that reloaded while it held the switch lock, for example during a usage check, blocked switching in every window for 2 minutes. A lock whose window is gone is now taken over at once.
- Fixed: in the instant modes, an older conversation writing back only its tokens made the tab re-check the login files about once a second, without saying why. It now warns once.
- Fixed: in the instant modes, switching in another window could show a false "login changed back" warning, and a newly opened window could say the last switch "did not stick".
- Fixed: **Show Log** from the Command Palette opened the accounts page instead of the log when the tab had been hidden.
- Fixed: the account list was greyed out during any background task, such as a terminal sign-in; now only while switching. Two tasks running at once no longer clear each other's progress banner.
- Fixed: clicking **Add account** twice could start two sign-ins, leaving one running out of sight.
- Fixed: on Windows, Add Account and usage checks could not start an npm-installed `claude` when the Claude Code extension's own CLI was missing.
- Fixed: "Last used" counted 24-hour periods, so an account used this morning could show "yesterday".
- The pencil button's tooltip says **Edit** rather than Rename.

## 0.10.0

- New setting `claudeRoster.switchMode` chooses what happens after a switch: `reloadWindow` (default, as before), `restartExtensions` (restart extensions only, a few seconds), or one of two instant modes that restart nothing: `newConversation` opens a new Claude Code conversation on the new account, and `instant` doesn't. In the instant modes, conversations that were already open keep the previous account until you start a new one.
- After an instant switch, Claude Switch watches for older conversations writing the previous login back. It quietly repairs a rewritten `oauthAccount`, and warns you, with a **Switch again** button, if the whole old login comes back.
- Clicking accounts repeatedly no longer starts one switch per click. While a switch runs, the account list is greyed out and further clicks are ignored. A notice that repeats replaces the one showing instead of stacking.
- Usage is up to date. Once a minute, while the tab is open, Claude Switch asks Claude Code's own CLI for the current usage, as Claude Code's Account & Usage panel does, instead of waiting for Claude Code to save it. Claude Switch still makes no network requests and never handles your token. New setting `claudeRoster.usageCheckSeconds` (default 60, `0` turns it off). After a switch, the new account's usage is checked right away.
- A limit that resets within the hour shows a countdown, such as "Resets in 23 minutes", instead of the clock time. It counts down while the tab is open.
- Usage bars turn yellow from 70% and red from 80% (were 75% and 90%), for an earlier warning.
- A switch now waits a few seconds for another window's switch or a usage check to finish, instead of failing.
- **Edit** (the pencil button, formerly Rename) changes an account's avatar colour as well as its name. Pick one of 12 colours, with a live preview.
- Notices now appear at the bottom of the tab, newest lowest, like VS Code's own notifications. They float over the tab, so nothing else moves when one appears.
- Fixed: after adding the account Claude was already signed in to, the log said "Kept the saved login … because it is newer than the live one" every 10 seconds. It now says it once, and auto-refresh no longer takes the switch lock for it.

## 0.9.0

- Everything now happens inside the Claude Switch tab. Name boxes, confirmations, account choices, progress and messages appear in the tab instead of VS Code input boxes, pick lists, dialogs and notifications. Press Escape to cancel a dialog.
- Saving the first account happens in the tab. The tab shows the current login with a **Save** button, and its icon shows a badge until the login is saved; there is no pop-up anymore.
- The status bar and **Switch Account** in the Command Palette open the tab, which is the account picker.
- Answers from the tab are checked again before Claude Switch uses them.

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
