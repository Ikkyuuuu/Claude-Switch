import type { AccountCard, HostMessage, LogEntry, Notice, PromptSpec, RosterViewState, UsageMeter, WebviewMessage } from './protocol';
import { AVATAR_COLOURS, initialsOf } from './avatar';
import { checkInput } from './rules';

/**
 * The Accounts view. Plain DOM, no framework. User data (names, emails) is
 * only ever inserted as text; innerHTML is used solely for the icon constants.
 */

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const app = document.getElementById('app') as HTMLElement;
const logoUrl = app.dataset.logo ?? '';
let state = vscode.getState() as RosterViewState | undefined;
let codeSent = false;
let rendered = false;
/** Which screen the tab shows. */
let page: 'accounts' | 'log' = 'accounts';
let logEntries: LogEntry[] = [];
type LogFilter = 'all' | LogEntry['level'];
let logFilter: LogFilter = 'all';
/** Entries up to this time have been seen on the log page. */
let logSeenAt = 0;
/** The dialog the extension is waiting on, notices at the bottom, and work in progress. */
let prompt: PromptSpec | null = null;
let notices: Notice[] = [];
let busyText: string | null = null;
/** Text typed into inputs, kept across re-renders by input id. */
const drafts = new Map<string, string>();
/** The colour picked in the Edit account dialog, kept across re-renders like drafts. */
let pickedColour: number | undefined;

function send(message: WebviewMessage): void {
  vscode.postMessage(message);
}

function openLogPage(): void {
  page = 'log';
  logSeenAt = Date.now();
  render();
  window.scrollTo(0, 0);
}

function closeLogPage(): void {
  page = 'accounts';
  render();
}

// ---------------------------------------------------------------- rendering

/** freshPrompt: a new dialog just arrived, so start it empty and focus it. */
function render(options: { freshPrompt?: boolean } = {}): void {
  if (page === 'accounts' && !state) {
    return;
  }
  // Re-rendering replaces the DOM; keep whatever was typed, and the focus.
  const activeId = document.activeElement instanceof HTMLElement ? document.activeElement.id : '';
  for (const input of app.querySelectorAll<HTMLInputElement>('input[id]')) {
    drafts.set(input.id, input.value);
  }
  if (options.freshPrompt) {
    drafts.delete('prompt-input');
    pickedColour = undefined;
  }

  const content = page === 'log' || !state ? logPage() : view(state);
  // While a dialog is open, the page behind it can't be clicked or tabbed into.
  const pageNode = h('div', { class: 'page', inert: !!prompt }, ...content, notifications());
  app.replaceChildren(pageNode, ...(prompt ? [dialog(prompt)] : []));
  if (!rendered) {
    // Only the first render fades in; later updates should not flicker.
    rendered = true;
    app.classList.add('intro');
    setTimeout(() => app.classList.remove('intro'), 800);
  }

  for (const input of app.querySelectorAll<HTMLInputElement>('input[id]')) {
    const draft = drafts.get(input.id);
    if (draft !== undefined) {
      input.value = draft;
    }
  }
  if (options.freshPrompt) {
    focusDialog();
  } else if (activeId) {
    document.getElementById(activeId)?.focus();
  }
}

// ---------------------------------------------------------------- dialogs and notices
// Everything the extension asks or tells appears here, not in VS Code pop-ups.

function answer(value?: string, action?: string, color?: number): void {
  if (prompt) {
    send(color === undefined ? { type: 'promptResult', id: prompt.id, value, action } : { type: 'promptResult', id: prompt.id, value, color });
  }
}

/** Name and avatar colour, with a live preview of the avatar. */
function profileForm(p: Extract<PromptSpec, { kind: 'profile' }>, cancel: HTMLElement): HTMLElement {
  const nameInput = (): HTMLInputElement => document.getElementById('prompt-input') as HTMLInputElement;
  const colour = (): number => pickedColour ?? p.color;
  const preview = h('span', { class: `avatar xl avatar-${colour()}`, 'aria-hidden': 'true' }, initialsOf(drafts.get('prompt-input') ?? p.value));
  const error = h('div', { class: 'dialog-error', id: 'prompt-error', 'aria-live': 'polite' });

  const swatches = Array.from({ length: AVATAR_COLOURS }, (_, n) =>
    h('button', {
      class: `swatch avatar-${n}`,
      type: 'button',
      role: 'radio',
      'aria-checked': String(n === colour()),
      'aria-label': `Colour ${n + 1}`,
      title: `Colour ${n + 1}`,
      // One tab stop for the group; arrow keys move between colours.
      tabindex: n === colour() ? '0' : '-1',
      onclick: () => pick(n),
      onkeydown: (event: Event) => {
        const key = (event as KeyboardEvent).key;
        const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[key];
        if (step) {
          event.preventDefault();
          pick((n + step + AVATAR_COLOURS) % AVATAR_COLOURS, true);
        }
      },
    }),
  );
  // Updates in place rather than re-rendering, so typing and focus are undisturbed.
  const pick = (n: number, focus = false): void => {
    pickedColour = n;
    preview.className = `avatar xl avatar-${n}`;
    swatches.forEach((s, i) => {
      s.setAttribute('aria-checked', String(i === n));
      s.tabIndex = i === n ? 0 : -1;
    });
    if (focus) {
      swatches[n].focus();
    }
  };

  return h(
    'form',
    {
      class: 'dialog-form',
      onsubmit: (event: Event) => {
        event.preventDefault();
        const value = nameInput().value;
        const problem = checkInput('alias', value, { taken: p.taken });
        if (problem) {
          error.textContent = problem;
          return;
        }
        answer(value.trim(), undefined, colour());
      },
    },
    h(
      'div',
      { class: 'profile-edit' },
      preview,
      h(
        'div',
        { class: 'profile-name' },
        h('label', { class: 'field-label', for: 'prompt-input' }, 'Name'),
        h('input', {
          id: 'prompt-input',
          type: 'text',
          value: p.value,
          autocomplete: 'off',
          spellcheck: 'false',
          'aria-describedby': 'prompt-error',
          oninput: () => {
            error.textContent = '';
            preview.textContent = initialsOf(nameInput().value);
          },
        }),
      ),
    ),
    error,
    h('div', { class: 'field-label', id: 'colour-label' }, 'Colour'),
    h('div', { class: 'swatches', role: 'radiogroup', 'aria-labelledby': 'colour-label' }, ...swatches),
    h('div', { class: 'dialog-actions' }, cancel, h('button', { class: 'btn primary', type: 'submit' }, p.confirmLabel)),
  );
}

function dialog(p: PromptSpec): HTMLElement {
  const cancel = h('button', { class: 'btn secondary', type: 'button', onclick: () => answer() }, 'Cancel');
  let body: Node[];
  if (p.kind === 'profile') {
    body = [profileForm(p, cancel)];
  } else if (p.kind === 'input') {
    const error = h('div', { class: 'dialog-error', id: 'prompt-error', 'aria-live': 'polite' });
    body = [
      h(
        'form',
        {
          class: 'dialog-form',
          onsubmit: (event: Event) => {
            event.preventDefault();
            const value = (document.getElementById('prompt-input') as HTMLInputElement).value;
            const problem = checkInput(p.rule, value, { taken: p.taken, optional: p.optional });
            if (problem) {
              error.textContent = problem;
              return;
            }
            answer(value);
          },
        },
        h('input', {
          id: 'prompt-input',
          type: 'text',
          value: p.value ?? '',
          placeholder: p.placeholder ?? '',
          autocomplete: 'off',
          spellcheck: 'false',
          'aria-labelledby': 'dialog-title',
          'aria-describedby': 'prompt-error',
          oninput: () => {
            error.textContent = '';
          },
        }),
        error,
        h('div', { class: 'dialog-actions' }, cancel, h('button', { class: 'btn primary', type: 'submit' }, p.confirmLabel)),
      ),
    ];
  } else if (p.kind === 'confirm') {
    body = [
      h(
        'div',
        { class: 'dialog-actions' },
        cancel,
        ...p.actions.map((a) =>
          h('button', { class: `btn ${a.style ?? 'secondary'}`, type: 'button', onclick: () => answer(undefined, a.id) }, a.label),
        ),
      ),
    ];
  } else {
    body = [
      h(
        'div',
        { class: 'choice-list' },
        ...p.options.map((o) =>
          h(
            'button',
            { class: 'choice', type: 'button', onclick: () => answer(undefined, o.id) },
            h('span', { class: 'choice-label' }, o.label),
            o.description ? h('span', { class: 'choice-desc' }, o.description) : null,
          ),
        ),
      ),
      h('div', { class: 'dialog-actions' }, cancel),
    ];
  }
  return h(
    'div',
    { class: 'overlay' },
    h(
      'div',
      { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dialog-title' },
      h('h2', { class: 'dialog-title', id: 'dialog-title' }, p.title),
      p.message ? h('p', { class: 'dialog-message' }, p.message) : null,
      ...body,
    ),
  );
}

function focusDialog(): void {
  const input = document.getElementById('prompt-input') as HTMLInputElement | null;
  if (input) {
    input.focus();
    input.select();
    return;
  }
  (app.querySelector('.dialog .btn.primary, .dialog .btn.danger, .dialog .choice') as HTMLElement | null)?.focus();
}

const NOTICE_ICONS: Record<Notice['level'], IconName> = { info: 'info', success: 'check', warning: 'warning', error: 'error' };

/**
 * Notices, newest at the bottom, then work in progress. They float over the
 * bottom of the tab without moving anything else.
 */
function notifications(): HTMLElement | null {
  if (!notices.length && !busyText) {
    return null;
  }
  return h(
    'div',
    { class: 'toasts' },
    ...notices.map((n) =>
      h(
        'div',
        { class: `toast ${n.level}`, role: n.level === 'error' || n.level === 'warning' ? 'alert' : 'status' },
        icon(NOTICE_ICONS[n.level]),
        h(
          'div',
          { class: 'toast-body' },
          h('div', { class: 'toast-text' }, n.text),
          n.actions?.length
            ? h(
                'div',
                { class: 'toast-actions' },
                ...n.actions.map((a) =>
                  h(
                    'button',
                    { class: `btn small ${a.style ?? 'ghost'}`, onclick: () => send({ type: 'noticeAction', id: n.id, action: a.id }) },
                    a.label,
                  ),
                ),
              )
            : null,
        ),
        iconButton('close', 'Dismiss', () => send({ type: 'noticeAction', id: n.id })),
      ),
    ),
    busyText
      ? h('div', { class: 'toast busy', role: 'status' }, h('span', { class: 'spinner small', 'aria-hidden': 'true' }), h('div', { class: 'toast-body' }, busyText))
      : null,
  );
}

function view(s: RosterViewState): Node[] {
  if (s.unsupported) {
    return [
      h(
        'main',
        { class: 'hero' },
        logo('hero-logo'),
        title(),
        h('p', { class: 'hero-tagline' }, 'macOS is not supported yet: Claude Code keeps logins in the Keychain there, not in files.'),
      ),
      footer(),
    ];
  }

  const hasAccounts = s.current.kind === 'account' || s.others.length > 0;
  const nodes: Node[] = [];
  if (s.reloadPending) {
    nodes.push(reloadBanner(s.reloadPending.alias));
  }

  if (!hasAccounts) {
    nodes.push(
      h(
        'main',
        { class: 'hero' },
        logo('hero-logo'),
        title(),
        h('p', { class: 'hero-tagline' }, 'Keep work and personal Claude accounts apart, and switch between them in one click.'),
        s.signIn
          ? signInCard(s.signIn)
          : h('button', { class: 'btn primary large', onclick: () => send({ type: 'add' }) }, icon('plus'), 'Add account'),
        s.current.kind === 'unsaved' && !s.signIn ? unsavedHint(s.current.email) : null,
        s.current.kind === 'error' ? errorCard(s.current.message) : null,
      ),
    );
  } else {
    nodes.push(brandBar());
    if (s.signIn) {
      nodes.push(signInCard(s.signIn));
    }
    nodes.push(section('Current account', currentCard(s.current)));
    nodes.push(
      section(
        s.others.length ? 'Switch to' : 'Other accounts',
        h(
          'div',
          { class: 'list' },
          ...s.others.map(accountRow),
          s.signIn
            ? null
            : h('button', { class: 'btn dashed', onclick: () => send({ type: 'add' }) }, icon('plus'), 'Add account'),
        ),
      ),
    );
  }
  nodes.push(footer());
  return nodes;
}

function title(): HTMLElement {
  return h('h1', { class: 'hero-title' }, 'Claude ', h('span', { class: 'accent-text' }, 'Switch'));
}

function brandBar(): HTMLElement {
  return h(
    'header',
    { class: 'brand' },
    logo('brand-logo'),
    h('span', { class: 'brand-name' }, 'Claude ', h('span', { class: 'accent-text' }, 'Switch')),
  );
}

function section(label: string, ...children: Node[]): HTMLElement {
  return h('section', { class: 'section' }, h('h2', { class: 'section-label' }, label), ...children);
}

function currentCard(current: RosterViewState['current']): HTMLElement {
  switch (current.kind) {
    case 'account': {
      const a = current.account;
      return h(
        'div',
        { class: 'card current account', 'data-vscode-context': context('activeProfile', a.id), title: lastUsed(a) },
        h(
          'div',
          { class: 'card-top' },
          avatar(a, 'lg'),
          h(
            'div',
            { class: 'card-text' },
            h('div', { class: 'card-title' }, h('span', { class: 'name' }, a.alias)),
            h('div', { class: 'card-sub' }, a.email),
            h(
              'div',
              { class: 'card-status' },
              a.expired
                ? h('span', { class: 'pill warn' }, icon('warning'), 'Sign-in expired')
                : h('span', { class: 'pill ok' }, 'Active'),
              a.plan ? h('span', { class: 'pill plan' }, a.plan) : null,
            ),
            a.expired ? h('p', { class: 'hint' }, 'Run /login in Claude Code to sign in again.') : null,
          ),
          h('div', { class: 'card-actions' }, iconButton('pencil', `Edit ${a.alias}`, () => send({ type: 'rename', profileId: a.id }))),
        ),
        usagePanel(a),
        renewalLine(a),
      );
    }
    case 'unsaved':
      return h(
        'div',
        { class: 'card current unsaved' },
        h('span', { class: 'avatar lg unknown', 'aria-hidden': 'true' }, '?'),
        h(
          'div',
          { class: 'card-text' },
          h('div', { class: 'card-title' }, 'Unsaved login'),
          h('div', { class: 'card-sub' }, current.email),
        ),
        h('button', { class: 'btn primary small', onclick: () => send({ type: 'saveCurrent' }) }, 'Save'),
      );
    case 'signed-out':
      return h(
        'div',
        { class: 'card current muted' },
        h('span', { class: 'avatar lg unknown', 'aria-hidden': 'true' }, icon('user')),
        h(
          'div',
          { class: 'card-text' },
          h('div', { class: 'card-title' }, 'Signed out'),
          h('div', { class: 'card-sub' }, 'Pick an account below to use it.'),
        ),
      );
    case 'error':
      return errorCard(current.message);
  }
}

function accountRow(a: AccountCard): HTMLElement {
  // While a switch runs, the rows wait; the extension ignores extra clicks too.
  const waiting = !!state?.switching;
  const switchTo = () => {
    if (!state?.switching) {
      send({ type: 'switch', profileId: a.id });
    }
  };
  return h(
    'div',
    {
      class: ['row', a.expired ? 'expired' : '', waiting ? 'waiting' : ''].filter(Boolean).join(' '),
      role: 'button',
      tabindex: '0',
      'aria-disabled': waiting ? 'true' : 'false',
      title: [`Switch to ${a.alias}`, usageSummary(a), lastUsed(a)].filter(Boolean).join('\n'),
      'aria-label': `Switch to ${a.alias}, ${a.email}${a.expired ? ', sign-in expired' : ''}`,
      'data-vscode-context': context('profile', a.id),
      onclick: switchTo,
      onkeydown: (event: Event) => {
        const key = (event as KeyboardEvent).key;
        if ((key === 'Enter' || key === ' ') && event.target === event.currentTarget) {
          event.preventDefault();
          switchTo();
        }
      },
    },
    avatar(a),
    h(
      'div',
      { class: 'row-text' },
      h(
        'div',
        { class: 'row-title' },
        h('span', { class: 'name' }, a.alias),
        a.expired ? h('span', { class: 'pill warn' }, 'Expired') : null,
        a.plan && !a.expired ? h('span', { class: 'pill plan' }, a.plan) : null,
      ),
      h('div', { class: 'row-sub' }, a.email),
      miniUsage(a),
    ),
    // Shown over the end of the row on hover, so names use the full width otherwise.
    h(
      'div',
      { class: 'row-end' },
      iconButton('pencil', `Edit ${a.alias}`, () => send({ type: 'rename', profileId: a.id })),
      iconButton('trash', `Remove ${a.alias}`, () => send({ type: 'remove', profileId: a.id })),
      h('span', { class: 'go', 'aria-hidden': 'true' }, a.expired ? 'Sign in' : 'Switch', icon('arrow')),
    ),
  );
}

function signInCard(signIn: NonNullable<RosterViewState['signIn']>): HTMLElement {
  const disabled = !signIn.hasLink;
  return h(
    'section',
    { class: 'card signin', 'aria-live': 'polite' },
    h(
      'div',
      { class: 'signin-head' },
      h('span', { class: 'spinner', 'aria-hidden': 'true' }),
      h(
        'div',
        {},
        h('div', { class: 'card-title' }, 'Waiting for you to sign in'),
        h('div', { class: 'card-sub' }, signIn.email ?? 'Finish in your browser'),
      ),
    ),
    h(
      'ol',
      { class: 'steps' },
      h(
        'li',
        {},
        h('div', { class: 'step-title' }, 'Approve access in your browser'),
        h(
          'div',
          { class: 'step-actions' },
          h('button', { class: 'btn secondary small', disabled, onclick: () => send({ type: 'signInOpen' }) }, icon('external'), 'Open page'),
          h('button', { class: 'btn ghost small', disabled, onclick: () => send({ type: 'signInCopy' }) }, icon('copy'), 'Copy link'),
        ),
      ),
      h(
        'li',
        {},
        h('div', { class: 'step-title' }, 'Got a code instead? Paste it here'),
        h(
          'form',
          {
            class: 'code-form',
            onsubmit: (event: Event) => {
              event.preventDefault();
              const input = document.getElementById('code') as HTMLInputElement;
              const code = input.value.trim();
              if (code) {
                send({ type: 'signInCode', code });
                input.value = '';
                codeSent = true;
                render();
              }
            },
          },
          h('input', {
            id: 'code',
            type: 'text',
            placeholder: 'Paste code',
            autocomplete: 'off',
            spellcheck: 'false',
            'aria-label': 'Code from the sign-in page',
          }),
          h('button', { class: 'btn primary small', type: 'submit' }, 'Submit'),
        ),
        codeSent ? h('div', { class: 'hint ok' }, icon('check'), 'Code sent. Finishing sign-in…') : null,
      ),
    ),
    h('button', { class: 'btn ghost small cancel', onclick: () => send({ type: 'signInCancel' }) }, 'Cancel'),
  );
}

function unsavedHint(email: string): HTMLElement {
  return h(
    'div',
    { class: 'card hint-card' },
    h('div', { class: 'card-sub' }, 'Claude is signed in as'),
    h('div', { class: 'card-title' }, email),
    h('button', { class: 'btn secondary small', onclick: () => send({ type: 'saveCurrent' }) }, icon('save'), 'Save this login'),
  );
}

function errorCard(message: string): HTMLElement {
  return h(
    'div',
    { class: 'banner error', role: 'alert' },
    icon('warning'),
    h('div', { class: 'banner-text' }, h('strong', {}, "Can't read Claude's login. "), message),
    h('button', { class: 'btn ghost small', onclick: openLogPage }, 'Show log'),
  );
}

function reloadBanner(alias: string | undefined): HTMLElement {
  return h(
    'div',
    { class: 'banner warn', role: 'status' },
    icon('refresh'),
    h('div', { class: 'banner-text' }, alias ? `Switched to “${alias}” in another window.` : 'The account was switched in another window.'),
    h('button', { class: 'btn primary small', onclick: () => send({ type: 'reload' }) }, 'Reload'),
  );
}

/** A full-width button to the activity log, with its size and any unseen problems. */
function footer(): HTMLElement {
  const unseen = logEntries.filter((e) => e.at > logSeenAt && e.level !== 'info');
  const unseenErrors = unseen.some((e) => e.level === 'error');
  const label = unseen.length
    ? `Activity log, ${unseen.length} new ${unseenErrors ? 'error' : 'warning'}${unseen.length === 1 ? '' : 's'}`
    : 'Activity log';
  return h(
    'footer',
    { class: 'footer' },
    h(
      'button',
      { class: 'log-button', onclick: openLogPage, 'aria-label': label, title: label },
      icon('list'),
      h('span', { class: 'log-button-label' }, 'Activity log'),
      unseen.length ? h('span', { class: `alert-dot ${unseenErrors ? 'error' : 'warn'}`, 'aria-hidden': 'true' }) : null,
      logEntries.length ? h('span', { class: 'count' }, String(logEntries.length)) : null,
      icon('chevron'),
    ),
  );
}

// ---------------------------------------------------------------- activity log

const LOG_FILTERS: { key: LogFilter; label: string; icon?: IconName }[] = [
  { key: 'all', label: 'All' },
  { key: 'info', label: 'Info', icon: 'info' },
  { key: 'warn', label: 'Warnings', icon: 'warning' },
  { key: 'error', label: 'Errors', icon: 'error' },
];

const LEVEL_LABELS: Record<LogEntry['level'], string> = { info: 'Info', warn: 'Warning', error: 'Error' };

/** The log page: what Claude Switch did since this window started, newest first, as a timeline. */
function logPage(): Node[] {
  const counts: Record<LogFilter, number> = { all: logEntries.length, info: 0, warn: 0, error: 0 };
  for (const entry of logEntries) {
    counts[entry.level]++;
  }
  const shown = logEntries.filter((e) => logFilter === 'all' || e.level === logFilter).reverse();
  const first = logEntries[0];

  const nodes: (Node | null)[] = [
    h(
      'header',
      { class: 'log-head' },
      iconButton('back', 'Back to accounts', closeLogPage),
      h(
        'div',
        { class: 'log-heading' },
        h('h1', { class: 'log-title' }, 'Activity log'),
        h(
          'div',
          { class: 'log-sub' },
          first ? `${counts.all} ${counts.all === 1 ? 'entry' : 'entries'} since ${sinceText(first.at)}` : 'Nothing yet',
        ),
      ),
      iconButton('copy', 'Copy the log', () => send({ type: 'copyLog' }), counts.all === 0),
      iconButton('trash', 'Clear the log', () => send({ type: 'clearLog' }), counts.all === 0),
    ),
    counts.all ? filterChips(counts) : null,
    shown.length ? timeline(shown) : emptyLog(counts.all > 0),
    h(
      'footer',
      { class: 'footer' },
      h('button', { class: 'link', onclick: () => send({ type: 'openOutput' }) }, icon('external'), 'Open in Output panel'),
    ),
  ];
  return nodes.filter((node): node is Node => node !== null);
}

function filterChips(counts: Record<LogFilter, number>): HTMLElement {
  return h(
    'div',
    { class: 'chips', role: 'tablist', 'aria-label': 'Show entries' },
    ...LOG_FILTERS.map((f) =>
      h(
        'button',
        {
          class: `chip ${f.key}${logFilter === f.key ? ' selected' : ''}`,
          role: 'tab',
          'aria-selected': String(logFilter === f.key),
          title: f.label,
          onclick: () => {
            logFilter = f.key;
            render();
          },
        },
        f.icon ? icon(f.icon) : h('span', {}, f.label),
        h('span', { class: 'chip-count' }, String(counts[f.key])),
      ),
    ),
  );
}

/** Entries grouped by day, newest first, on a vertical line with a dot per entry. */
function timeline(entries: LogEntry[]): HTMLElement {
  const groups: { day: string; entries: LogEntry[] }[] = [];
  for (const entry of entries) {
    const day = dayLabel(new Date(entry.at));
    const last = groups[groups.length - 1];
    if (last?.day === day) {
      last.entries.push(entry);
    } else {
      groups.push({ day, entries: [entry] });
    }
  }
  return h(
    'div',
    { class: 'timeline' },
    ...groups.flatMap((g) => [
      h('h2', { class: 'section-label' }, g.day),
      h('ol', { class: 'tl', 'aria-label': `Activity, ${g.day}` }, ...g.entries.map(logItem)),
    ]),
  );
}

function logItem(e: LogEntry): HTMLElement {
  const at = new Date(e.at);
  return h(
    'li',
    { class: `tl-item ${e.level}` },
    h('span', { class: 'tl-dot', 'aria-hidden': 'true' }),
    h('div', { class: 'tl-message' }, ...emphasise(e.message)),
    h(
      'div',
      { class: 'tl-meta' },
      e.level === 'info' ? null : h('span', { class: 'tl-level' }, LEVEL_LABELS[e.level]),
      h('time', { datetime: at.toISOString(), title: at.toLocaleString() }, `${shortTime(e.at)} · ${ago(e.at)}`),
    ),
  );
}

function emptyLog(filtered: boolean): HTMLElement {
  return h(
    'div',
    { class: 'log-empty' },
    icon(filtered ? 'list' : 'check'),
    h('div', { class: 'log-empty-title' }, filtered ? 'No entries of this kind' : 'No activity yet'),
    h('div', { class: 'hint' }, filtered ? 'Choose another filter above.' : 'Switches, sign-ins and problems show up here.'),
  );
}

/** Shows quoted account names in bold. Text nodes only, never HTML. */
function emphasise(message: string): Node[] {
  return message
    .split(/("[^"\n]{1,80}")/)
    .filter(Boolean)
    .map((part) => (/^".+"$/.test(part) ? h('strong', {}, part.slice(1, -1)) : document.createTextNode(part)));
}

const shortTimeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

function shortTime(ms: number): string {
  return shortTimeFormat.format(ms);
}

/** "6:06 PM" today, otherwise "yesterday, 6:06 PM" or "Monday, Oct 19, 6:06 PM". */
function sinceText(ms: number): string {
  const day = dayLabel(new Date(ms));
  if (day === 'Today') {
    return shortTime(ms);
  }
  return `${day === 'Yesterday' ? 'yesterday' : day}, ${shortTime(ms)}`;
}

function dayLabel(at: Date): string {
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (at.toDateString() === today.toDateString()) {
    return 'Today';
  }
  return at.toDateString() === yesterday.toDateString() ? 'Yesterday' : dayFormat.format(at);
}

// ---------------------------------------------------------------- usage and renewal

/** Meters for the active account's limits, from Claude Code's own /usage numbers. */
function usagePanel(a: AccountCard): HTMLElement {
  if (!a.usage?.meters.length) {
    return h(
      'div',
      { class: 'details' },
      h('p', { class: 'hint' }, 'No usage yet. Run /usage in Claude Code.'),
    );
  }
  return h(
    'div',
    { class: 'details' },
    ...a.usage.meters.map(meter),
    h(
      'div',
      { class: 'details-foot' },
      h('span', {}, `Updated ${ago(a.usage.updatedAt)}`),
    ),
  );
}

function meter(m: UsageMeter): HTMLElement {
  const reset = hasReset(m);
  const percent = reset ? 0 : m.percent;
  const fill = h('span', { class: 'meter-fill' });
  fill.style.width = `${percent}%`;
  return h(
    'div',
    {
      class: `meter${level(percent)}`,
      role: 'meter',
      'aria-label': m.label,
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': String(percent),
    },
    h('span', { class: 'meter-label' }, m.label),
    h('span', { class: 'meter-value' }, reset ? 'Reset' : `${percent}%`),
    h('span', { class: 'meter-bar' }, fill),
    m.resetsAt && !reset ? h('span', { class: 'meter-reset', 'data-resets': m.resetsAt }, resetText(m.resetsAt)) : null,
  );
}

function renewalLine(a: AccountCard): HTMLElement {
  const r = a.renewal;
  const setDate = h(
    'button',
    { class: 'link', onclick: () => send({ type: 'setRenewal', profileId: a.id }) },
    r?.kind === 'date' ? 'Edit' : 'Set date',
  );
  const billing = h('button', { class: 'link', onclick: () => send({ type: 'openBilling' }) }, 'Billing', icon('external'));

  let text: Node;
  if (r?.kind === 'date') {
    text = h(
      'span',
      { class: 'renewal-text' },
      'Renews ',
      h('strong', {}, formatDate(r.date)),
      h('span', { class: 'muted' }, ` · ${daysUntil(r.date)}`),
      r.estimated
        ? h('span', { class: 'tag', title: 'Estimated from the subscription start date. Set the exact date from the billing page.' }, 'estimated')
        : null,
    );
  } else if (r?.kind === 'organization') {
    text = h('span', { class: 'renewal-text' }, 'Billed by your organization');
  } else {
    text = h('span', { class: 'renewal-text muted' }, 'Renewal date not known');
  }
  return h('div', { class: 'renewal' }, icon('calendar'), text, h('span', { class: 'renewal-actions' }, setDate, billing));
}

/** One line under another account: its weekly usage when last seen, and its renewal. */
const SHORT_LABELS: Record<UsageMeter['key'], string> = {
  session: 'Session',
  weekly: 'Week',
  weeklyOpus: 'Opus',
  weeklySonnet: 'Sonnet',
};

/**
 * Under another account: every limit as last seen, each with its reset time,
 * then how old the numbers are and the renewal date.
 */
function miniUsage(a: AccountCard): HTMLElement | null {
  const lines: Node[] = (a.usage?.meters ?? []).map((m) => {
    const reset = hasReset(m);
    const fill = h('i', {});
    fill.style.width = `${reset ? 0 : m.percent}%`;
    return h(
      'div',
      { class: `mini${reset ? '' : level(m.percent)}` },
      h('span', { class: 'mini-label' }, SHORT_LABELS[m.key]),
      h('span', { class: 'mini-bar' }, fill),
      h('span', { class: 'mini-value' }, reset ? 'reset' : `${m.percent}%`),
      !reset && m.resetsAt ? h('span', { class: 'mini-reset', 'data-resets': m.resetsAt, 'data-prefix': 'resets' }, resetText(m.resetsAt, 'resets')) : null,
    );
  });
  const foot = [
    a.usage ? `as of ${ago(a.usage.updatedAt)}` : undefined,
    a.renewal?.kind === 'date' ? `renews ${formatDate(a.renewal.date)}` : undefined,
  ].filter(Boolean);
  if (foot.length) {
    lines.push(h('div', { class: 'mini-foot' }, foot.join(' · ')));
  }
  return lines.length ? h('div', { class: 'minis' }, ...lines) : null;
}

/** Yellow from 70%, red from 80%, as a class suffix. */
function level(percent: number): string {
  return percent >= 80 ? ' danger' : percent >= 70 ? ' warn' : '';
}

function usageSummary(a: AccountCard): string {
  if (!a.usage?.meters.length) {
    return '';
  }
  const meters = a.usage.meters.map((m) => `${m.label}: ${hasReset(m) ? 'reset' : `${m.percent}%`}`).join(', ');
  return `${meters} (as of ${ago(a.usage.updatedAt)})`;
}

/** A limit whose reset time has passed has started over since the numbers were taken. */
function hasReset(m: UsageMeter): boolean {
  return !!m.resetsAt && Date.parse(m.resetsAt) <= Date.now();
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayTimeFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "Resets in 23 minutes" within the hour, else the clock time, with the day if it isn't today. */
function resetText(iso: string, prefix = 'Resets'): string {
  const at = new Date(iso);
  const minutes = Math.ceil((at.getTime() - Date.now()) / 60_000);
  if (minutes > 0 && minutes < 60) {
    return `${prefix} ${relativeFormat.format(minutes, 'minute')}`;
  }
  return `${prefix} ${at.toDateString() === new Date().toDateString() ? timeFormat.format(at) : dayTimeFormat.format(at)}`;
}

/** YYYY-MM-DD as a local date. */
function localDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function formatDate(value: string): string {
  return dateFormat.format(localDate(value));
}

function daysUntil(value: string): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((localDate(value).getTime() - today.getTime()) / 86_400_000);
  return days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
}

function ago(ms: number): string {
  const minutes = Math.round((ms - Date.now()) / 60_000);
  if (minutes > -1) {
    return 'just now';
  }
  if (minutes > -60) {
    return relativeFormat.format(minutes, 'minute');
  }
  const hours = Math.round(minutes / 60);
  return hours > -24 ? relativeFormat.format(hours, 'hour') : relativeFormat.format(Math.round(hours / 24), 'day');
}

// ---------------------------------------------------------------- pieces

function avatar(a: AccountCard, size?: 'lg'): HTMLElement {
  const classes = ['avatar', `avatar-${a.avatar}`, size, a.expired ? 'expired' : undefined].filter(Boolean).join(' ');
  return h('span', { class: classes, 'aria-hidden': 'true' }, a.initials);
}

function logo(className: string): HTMLElement {
  return h('img', { class: className, src: logoUrl, alt: '' });
}

function iconButton(name: IconName, label: string, action: () => void, disabled = false): HTMLElement {
  return h(
    'button',
    {
      class: 'icon-btn',
      title: label,
      'aria-label': label,
      disabled,
      onclick: (event: Event) => {
        event.stopPropagation();
        action();
      },
    },
    icon(name),
  );
}

/** Lets VS Code show Edit and Remove when a card is right-clicked. */
function context(section: string, profileId: string): string {
  return JSON.stringify({ webviewSection: section, profileId, preventDefaultContextMenuItems: true });
}

function lastUsed(a: AccountCard): string {
  if (!a.lastUsedAt) {
    return '';
  }
  // Calendar days, so this morning is "today" and last night is "yesterday".
  const startOfDay = (time: Date) => new Date(time.getFullYear(), time.getMonth(), time.getDate()).getTime();
  const days = Math.round((startOfDay(new Date(a.lastUsedAt)) - startOfDay(new Date())) / 86_400_000);
  return `Last used ${days === 0 ? 'today' : relativeFormat.format(days, 'day')}`;
}

type Child = Node | string | null | undefined | false;
type Attr = string | boolean | ((event: Event) => void) | undefined;

function h(tag: string, attrs: Record<string, Attr>, ...children: Child[]): HTMLElement {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === 'function') {
      element.addEventListener(key.slice(2), value);
    } else if (value === true) {
      element.setAttribute(key, '');
    } else if (typeof value === 'string') {
      element.setAttribute(key, value);
    }
  }
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) {
      element.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
  }
  return element;
}

// ---------------------------------------------------------------- icons

const ICONS = {
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  pencil: '<path d="M10.8 2.7l2.5 2.5L6 12.5l-3.1.6.6-3.1z"/><path d="M9.3 4.2l2.5 2.5"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5"/><path d="M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
  external: '<path d="M9.5 2.5h4v4M13.5 2.5L8 8"/><path d="M11.5 9.5v4h-9v-9h4"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M2.5 10.5v-7a1 1 0 0 1 1-1h7"/>',
  warning: '<path d="M8 2.5l6 10.5H2z"/><path d="M8 6.5v3M8 11.3v.2"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.8v3h-3"/>',
  check: '<path d="M3.5 8.5l3 3 6-7"/>',
  arrow: '<path d="M3 8h9.5M9 4.5L12.5 8 9 11.5"/>',
  save: '<path d="M3 2.5h8l2.5 2.5v8.5h-11z"/><path d="M5.5 2.5v3h5v-3M5 13.5v-4h6v4"/>',
  user: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3 13.5c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5"/>',
  calendar: '<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>',
  back: '<path d="M13 8H3.5M7 4.5L3.5 8 7 11.5"/>',
  chevron: '<path d="M6 3.5L10.5 8 6 12.5"/>',
  list: '<path d="M6 4.5h7.5M6 8h7.5M6 11.5h7.5"/><path d="M2.75 4.5h.01M2.75 8h.01M2.75 11.5h.01" stroke-width="2"/>',
  info: '<circle cx="8" cy="8" r="5.5"/><path d="M8 7.3v3.7M8 5.2v.1"/>',
  error: '<circle cx="8" cy="8" r="5.5"/><path d="M6 6l4 4M10 6l-4 4"/>',
  close: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
} as const;
type IconName = keyof typeof ICONS;

function icon(name: IconName): HTMLElement {
  const span = document.createElement('span');
  span.className = 'icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

// ---------------------------------------------------------------- start
// Last, so every constant above exists before the first render.

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  switch (message?.type) {
    case 'state':
      if (!message.state.signIn) {
        codeSent = false;
      }
      state = message.state;
      vscode.setState(state);
      render();
      break;
    case 'log':
      logEntries = Array.isArray(message.entries) ? message.entries : [];
      if (page === 'log') {
        logSeenAt = Date.now();
      }
      // The accounts page shows the log size and any new problems on its footer button.
      render();
      break;
    case 'openLog':
      openLogPage();
      break;
    case 'prompt': {
      const fresh = !!message.prompt && message.prompt.id !== prompt?.id;
      prompt = message.prompt;
      render({ freshPrompt: fresh });
      break;
    }
    case 'notices':
      notices = Array.isArray(message.notices) ? message.notices : [];
      render();
      break;
    case 'busy':
      busyText = message.text;
      render();
      break;
  }
});
// Escape cancels the open dialog, wherever the focus is.
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && prompt) {
    event.preventDefault();
    answer();
  }
});
// A restored webview shows its last state at once; the extension then sends a fresh one.
if (state) {
  render();
}
vscode.postMessage({ type: 'ready' });

// Keeps "Updated 5 minutes ago" and reset times current, without disturbing focus or typing.
setInterval(() => {
  if (state && !app.contains(document.activeElement)) {
    render();
  }
}, 60_000);

// "Resets in 23 minutes" counts down in place, even while focus is in the tab.
setInterval(() => {
  for (const span of app.querySelectorAll<HTMLElement>('[data-resets]')) {
    span.textContent = resetText(span.dataset.resets ?? '', span.dataset.prefix);
  }
}, 15_000);
