# Claude Switch (unofficial)

Switch which Claude account the **Claude Code VS Code extension** uses, and with it the `claude` CLI in VS Code's terminal, since both read the same `~/.claude` configuration.

> **Unofficial.** This extension is not made, endorsed or supported by Anthropic. It works by swapping Claude Code's internal login files, so a Claude Code update can stop it from working. When that happens it refuses to switch instead of guessing.

<p align="center">
  <img src="https://raw.githubusercontent.com/Ikkyuuuu/Claude-Switch/main/images/accounts.png" width="340" alt="The Claude Switch tab: the active account with its session and weekly usage meters, and a second account ready to switch to">
</p>

## Install

Search for **Claude Switch** in the Extensions view (`Ctrl+Shift+X`) and click **Install**:

<p align="center">
  <img src="https://raw.githubusercontent.com/Ikkyuuuu/Claude-Switch/main/images/install.png" width="435" alt="Claude Switch (unofficial) by Wattanun Teeratanapong in the VS Code Extensions view, with its Install button">
</p>

Or press `Ctrl+P` and run `ext install wattanun42.claude-switch-accounts`.

## Supported platforms

| Platform | Status |
| --- | --- |
| Windows | Supported |
| Linux, WSL, Remote SSH | Expected to work, because Claude Code keeps logins in the same files there. Less tested. |
| macOS | Not supported. Claude Code keeps logins in the macOS Keychain, not in files. |

Out of scope: the Claude desktop app and claude.ai in a browser.

## How to use it

There are three ways in:

- **Claude Switch tab** in the activity bar (two people with swap arrows):
  - With no saved accounts, it shows a welcome page with an **Add account** button.
  - Otherwise, the active account sits on top in a highlighted card, and your other accounts are listed below it.
  - Click an account to switch to it. Hover over it for rename and remove buttons, or right-click it for the same actions.
  - While you add an account, a sign-in card walks you through it.
  - The **+** button in the title bar adds an account. The **⋯** menu holds Restore Last Backup, Re-capture Current Login, Show Log and Remove All Saved Data.
  - The tab shows a badge when an account needs a new sign-in, or when the window needs a reload.
  - The **Activity log** button at the bottom shows how many entries there are, with a yellow or red dot for warnings or errors you haven't seen yet. It opens the log page right in the tab:
    - a timeline grouped by day, newest first
    - filter chips for info, warnings and errors
    - **Copy** and **Clear** buttons
  - The view follows your colour theme, including light and high-contrast themes, with Facebook blue as its accent colour.
- **Status bar:** click the account name, for example `$(account) Work`, to open a quick picker.
- **Command Palette:** run any of these commands.

| Command | What it does |
| --- | --- |
| **Claude Switch: Switch Account** | Pick a saved account. Claude Switch swaps the login and reloads the window. |
| **Claude Switch: Add Account** | Signs in to another account in your browser, with progress shown in the Claude Switch tab. Your current login is not affected. |
| **Claude Switch: Rename Account** | Changes the name shown for an account. |
| **Claude Switch: Remove Account** | Deletes a saved account and its backups from this device. The active account cannot be removed. |
| **Claude Switch: Save Current Login** | Saves the account Claude is signed in to, if it isn't saved yet. |
| **Claude Switch: Re-capture Current Login** | Saves the live login into its saved account, for example after you ran `/login` in Claude. |
| **Claude Switch: Restore Last Backup** | Puts back the login from just before the last switch. |
| **Claude Switch: Set Renewal Date** | Replaces an account's estimated renewal date with the real one. Leave it empty to go back to the estimate. |
| **Claude Switch: Refresh** | Re-reads the live login and updates the account list. |
| **Claude Switch: Show Log** | Opens the activity log page in the Claude Switch tab. Secrets are never written to it. A copy also goes to the "Claude Switch" Output channel. |
| **Claude Switch: Remove All Saved Data** | Deletes every account and backup Claude Switch saved. The live Claude login stays as it is. |

On first start, Claude Switch finds the account you are signed in to and asks once whether to save it as your first account.

### Usage and renewal

Each account card shows the account's plan (for example Team, Pro or Max 20x), its usage and its renewal date.

- **Usage:** the active account shows meters for the 5-hour session and the weekly limit, with their reset times. These are the same numbers as `/usage` in Claude Code. Meters are blue, turn yellow when nearly full (75%) and red when almost full (90%).
- **Where the numbers come from:** Claude Switch reads them from the cache Claude Code keeps in `.claude.json`, so it makes no network calls. Claude Switch re-reads that cache every 10 seconds while the window is focused (see `claudeRoster.autoRefreshSeconds`). The numbers are as fresh as Claude Code's last check; run `/usage` in Claude Code to update them.
- **Other accounts:** show the session and weekly numbers from when each was last active, with reset times and how old the numbers are. A limit whose reset time has passed shows as **reset**.
- **Renewal:**
  - Pro and Max plans show a date *estimated* from the subscription start date, assuming monthly billing.
  - Team and Enterprise plans show **Billed by your organization**.
  - To show the exact date, click **Set date** (or run **Claude Switch: Set Renewal Date**) and enter it from the claude.ai billing page. The **Billing** link opens that page. A date you set rolls forward every month or year.

### Adding an account

1. Click **+** in the Claude Switch tab. Enter the account's email if you like (it pre-fills the sign-in page), or press Enter to skip.
2. Your browser opens the Claude sign-in page. Approve access with the account you want to add.
3. Back in VS Code, name the account. That's it: no terminal is involved.

While the sign-in runs, the tab shows a sign-in card with these options:

- **Open page:** if the browser didn't open.
- **Copy link:** for a private window or another browser.
- **Paste code:** a box for the code, if the sign-in page shows one instead of finishing on its own.
- **Cancel.**

<p align="center">
  <img src="https://raw.githubusercontent.com/Ikkyuuuu/Claude-Switch/main/images/sign-in.png" width="344" alt="The sign-in card: waiting for you to sign in, with buttons to open the sign-in page or copy its link, and a box to paste a code">
</p>

If your browser is already signed in to claude.ai as a different account, the sign-in page approves *that* account. Sign out of claude.ai first, or copy the link into a private window.

Under the hood, **Add Account** runs `claude auth login` as a hidden background process, with `CLAUDE_CONFIG_DIR` pointing at a temporary folder. It uses the CLI bundled with the Claude Code extension, or `claude` on PATH. If that fails, Claude Switch offers to sign in in a terminal instead.

In the account lists, a check mark shows the active account. A warning sign means the saved login has expired (its refresh token is past its expiry date) and you need to sign in to it again.

### Before you switch

- **Exit `claude` sessions running in terminals.** They keep the old account in memory until restarted, and they can write the old login back when they refresh their tokens.
- **Reload your other VS Code windows when asked.** After a switch, every other window shows a "Reload now?" prompt and a `Reload for …` item in the status bar. Until it reloads, a window's Claude Code still runs the old account.
- Any Claude task running in the window that switches stops when the window reloads.

## Files this extension touches

Claude Switch reads and writes **only** these files:

| File | Access | Why |
| --- | --- | --- |
| `%USERPROFILE%\.claude\.credentials.json` (or `$CLAUDE_CONFIG_DIR/.credentials.json`) | Read, replace | Claude Code's login tokens. Replaced as a whole on a switch. |
| `%USERPROFILE%\.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`) | Read, patch | Only the `oauthAccount` key (the signed-in identity) is changed. Every other key, the indentation and the line endings are kept. Claude Switch also reads `cachedUsageUtilization` (Claude Code's `/usage` cache) to show usage; it never writes that key. |
| `<file>.roster-<random>.tmp` next to each file above | Create, rename | Writes go to a temp file first, which is then renamed over the target, so a file is never half-written. |
| `%TEMP%\claude-roster-login-<random>\` | Create, delete | Isolated sign-in folder for **Add Account**. Deleted right after the login is captured. Claude Switch refuses to delete any other path. |
| VS Code global storage for this extension: `switch-signal.json`, `switch.lock` | Create, write | Tells other windows to reload, and stops two windows from switching at the same time. Contains no secrets. |

Note that `.credentials.json` can also hold sign-ins for MCP servers. Because the whole file is swapped, those sign-ins move with each account.

### How a switch works

1. **Sync back:** save the live login into its account, because Claude refreshes tokens while it runs. A login whose tokens and identity disagree (a sign of a mixed-up state) is never saved.
2. **Backup:** keep the live login in one of 3 rotating backups.
3. **Apply:** write the target's `.credentials.json`, then patch `oauthAccount`.
4. **Validate:** read both files back. On any difference, restore the previous files exactly.
5. **Reload:** reload this window and signal the other windows. After the reload, Claude Switch checks that the switch stuck, and repairs `oauthAccount` if the exiting Claude process wrote the old one back.

## Security and privacy

- **Encrypted storage only.** Tokens and account details are kept in VS Code's SecretStorage, which uses the operating system's encryption. Settings, `globalState`, logs and error messages never contain them. `globalState` holds only display data:

- the account name and email
- a hash of the account and organization IDs
- the plan name and subscription start date
- the last usage percentages seen
- any renewal date you set
- **No network access of its own.** There is no telemetry, and Claude Switch makes no network calls. The only process it starts is the Claude Code CLI's own `claude auth login` for **Add Account**. The CLI talks to Anthropic exactly as it does when you sign in from Claude Code.
- **Narrow file access.** Only the files listed above are touched.
- **Fail closed.** If a Claude file has a shape Claude Switch doesn't recognise, it refuses to switch.
- **Local only.** Nothing leaves the device. Removing an account wipes its tokens and its backups. **Remove All Saved Data** wipes everything Claude Switch saved. Uninstalling the extension doesn't clear SecretStorage, so run that command first.
- The extension never runs code from the open workspace. The CLI path used for signing in (`claudeRoster.claudePath`) can only be set in user settings, never by a workspace.
- The sign-in code you paste goes straight to the CLI and is never logged or stored.
- **Locked-down view:**
  - The Accounts view loads nothing from the internet, and its content security policy allows only its own bundled script and stylesheet.
  - Account names and emails are shown as plain text, never as HTML.
  - Tokens and the sign-in link never reach the view.
  - Every message from the view is validated before the extension acts on it.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `claudeRoster.claudePath` | *(empty)* | Path to the Claude Code CLI that **Add Account** uses. Empty means the CLI bundled with the Claude Code extension, else `claude` on PATH. Machine scope. |
| `claudeRoster.confirmBeforeSwitch` | `true` | Ask before switching and reloading. |
| `claudeRoster.autoRefreshSeconds` | `10` | How often the tab and status bar re-read the login and usage while the window is focused. Local file reads only. `0` turns it off; the minimum is 5. |

If `CLAUDE_CONFIG_DIR` is set, Claude Switch switches the login in that folder and warns you once, because the Claude Code VS Code extension has been reported to ignore that variable.

## License

MIT. See [LICENSE](LICENSE).

## Terms of service

Keeping work and personal accounts apart is the usual reason to use this extension. Rotating several personal subscriptions to get around usage limits may conflict with Anthropic's terms, so read them first. This is not legal advice.

## Development

```powershell
npm install
npm run compile            # type-check, lint, bundle into dist/
npm run test:unit          # engine tests against a fake home folder
npm run test:integration   # runs inside VS Code 1.100.0 (downloaded to %TEMP%)
npm run vsix               # builds claude-switch-accounts-<version>.vsix
```

- Press **F5** and choose **Run Extension (sandbox Claude folder)** to try the UI with `CLAUDE_CONFIG_DIR` pointing at a temp folder. Your real login is not touched.
- **Run Extension (real Claude login)** uses your real files. Back them up first (see below).
- Integration tests always use a fresh, fake `CLAUDE_CONFIG_DIR` and a separate VS Code profile. Set `ROSTER_TEST_VSCODE=stable` to also test the latest VS Code.

### Manual test checklist

Back up your login first. The copy contains live tokens, so delete it when you are done:

```powershell
$dst = "$env:USERPROFILE\claude-backup-$(Get-Date -f yyyyMMdd-HHmm)"
New-Item -ItemType Directory $dst | Out-Null
Copy-Item "$env:USERPROFILE\.claude\.credentials.json", "$env:USERPROFILE\.claude.json" $dst
```

- [ ] Switch back and forth between two real accounts. Check both the Claude panel and `claude` in the terminal.
- [ ] Leave it overnight so tokens refresh, then switch again.
- [ ] Switch with two windows open, and with `claude` running in a terminal.
- [ ] Corrupt `.claude.json` (for example, make `oauthAccount` a string). Claude Switch must refuse to switch and leave the file alone.
- [ ] Add Account in the browser, then try it with **Paste code…** and with **Copy sign-in link** in a private window.
- [ ] Cancel an Add Account from the tab and from the notification. The `%TEMP%\claude-roster-login-*` folder must be gone each time.

### Project layout

```
src/
  extension.ts     activate(): commands, status bar, window sync
  commands.ts      UI flows (QuickPick, prompts) for every command
  accountsView.ts  webview provider for the Claude Switch tab (CSP, messages)
  viewModel.ts     builds what the view shows; validates messages from it
  accountDetails.ts  plan, cached usage and renewal dates (no network)
  rosterLog.ts     in-memory activity log shown in the tab
  webview/         the view's browser code (main.ts) and the message types
  switchEngine.ts  sync-back → backup → apply → validate → rollback
  claudeFiles.ts   path resolution, atomic write, oauthAccount patch, schema checks
  profileStore.ts  globalState + SecretStorage wrapper
  addAccount.ts    isolated sign-in folder, `claude auth login` process, polling
  windowSync.ts    signal file between windows
  statusBar.ts     status bar item
  log.ts           logger interface and secret redaction
media/
  logo.svg         the logo (source of icon.png)
  icon.png         Marketplace and extension list icon (256 × 256)
  roster.css       styles for the Accounts view
resources/
  roster.svg       activity bar icon (monochrome)
test/
  unit/            runs in Node with an in-memory SecretStorage
  integration/     runs inside VS Code via @vscode/test-cli
```
