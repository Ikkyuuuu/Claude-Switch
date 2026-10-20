import * as assert from 'node:assert/strict';
import { identityOf } from '../../src/claudeFiles';
import { ProfileMeta } from '../../src/profileStore';
import { AVATAR_COLOURS, avatarOf, buildViewState, colourOf, initialsOf, parseMessage } from '../../src/viewModel';
import { fakeAccount, fakeLogin } from '../fixtures';

function profile(name: string, extra: Partial<ProfileMeta> = {}): ProfileMeta {
  return {
    id: `id-${name}`,
    alias: name,
    email: `${name.toLowerCase()}@example.test`,
    identity: identityOf(fakeAccount(name)),
    addedAt: '2026-01-01T00:00:00.000Z',
    status: 'ok',
    ...extra,
  };
}

suite('viewModel', () => {
  const work = profile('Work');
  const personal = profile('Personal', { status: 'needs-relogin' });

  test('puts the active account on top and the rest below', () => {
    const state = buildViewState({
      profiles: [work, personal],
      live: { kind: 'known', profile: work, login: fakeLogin('Work') },
      hasBackup: true,
    });
    assert.equal(state.current.kind, 'account');
    assert.equal(state.current.kind === 'account' && state.current.account.alias, 'Work');
    assert.deepEqual(
      state.others.map((card) => [card.alias, card.expired]),
      [['Personal', true]],
    );
    assert.equal(state.hasBackup, true);
  });

  test('shows an unsaved login by email only', () => {
    const state = buildViewState({ profiles: [], live: { kind: 'unknown', login: fakeLogin('Stranger') }, hasBackup: false });
    assert.deepEqual(state.current, { kind: 'unsaved', email: 'stranger@example.test' });
    assert.ok(!JSON.stringify(state).includes('fake-access'), 'no tokens reach the webview');
  });

  test('passes errors and signed-out through', () => {
    assert.deepEqual(buildViewState({ profiles: [work], live: { kind: 'signed-out' }, hasBackup: false }).current, {
      kind: 'signed-out',
    });
    assert.deepEqual(buildViewState({ profiles: [], live: { kind: 'error', message: 'bad' }, hasBackup: false }).current, {
      kind: 'error',
      message: 'bad',
    });
  });

  test('tells the webview whether a sign-in link exists, but never the link', () => {
    const input = { profiles: [], live: { kind: 'signed-out' } as const, hasBackup: false };
    assert.deepEqual(buildViewState({ ...input, signIn: { email: 'a@b.test' } }).signIn, { email: 'a@b.test', hasLink: false });
    const withLink = buildViewState({ ...input, signIn: { url: 'https://claude.example.test/oauth?state=secret' } });
    assert.equal(withLink.signIn?.hasLink, true);
    assert.ok(!JSON.stringify(withLink).includes('https://'));
  });

  test('shows plan, usage meters and renewal on each card', () => {
    const now = new Date(2026, 1, 10).getTime();
    const team = profile('Team', {
      plan: { label: 'Team', personal: false },
      usage: { fetchedAt: 5, session: { percent: 41.6, resetsAt: '2026-02-10T12:00:00.000Z' }, weekly: { percent: 70 } },
    });
    const pro = profile('Pro', { plan: { label: 'Pro', personal: true, subscribedAt: '2025-01-31T10:00:00' } });
    const fixed = profile('Fixed', {
      plan: { label: 'Max 5x', personal: true, subscribedAt: '2025-01-31T10:00:00' },
      renewal: { date: '2026-02-14', cycle: 'monthly' },
    });
    const state = buildViewState({ profiles: [team, pro, fixed], live: { kind: 'signed-out' }, hasBackup: false, now });
    const [teamCard, proCard, fixedCard] = state.others;

    assert.equal(teamCard.plan, 'Team');
    assert.deepEqual(teamCard.usage, {
      updatedAt: 5,
      meters: [
        { key: 'session', label: 'Session (5 hours)', percent: 42, resetsAt: '2026-02-10T12:00:00.000Z' },
        { key: 'weekly', label: 'This week', percent: 70, resetsAt: undefined },
      ],
    });
    assert.deepEqual(teamCard.renewal, { kind: 'organization' });
    assert.deepEqual(proCard.renewal, { kind: 'date', date: '2026-02-28', estimated: true });
    assert.deepEqual(fixedCard.renewal, { kind: 'date', date: '2026-02-14', estimated: false });
    assert.equal(work.plan, undefined);
  });

  test('makes initials from one or two words, in any script', () => {
    assert.equal(initialsOf('Work'), 'W');
    assert.equal(initialsOf('acme team'), 'AT');
    assert.equal(initialsOf('  Side   Project  extra '), 'SP');
    assert.equal(initialsOf('งาน บ้าน'), 'งบ');
    assert.equal(initialsOf('   '), '?');
  });

  test('gives each account a stable avatar colour', () => {
    for (const id of ['a', 'id-Work', '7f9c2ba4-e88f-11ee-8c90-0242ac120002']) {
      const colour = avatarOf(id);
      assert.equal(avatarOf(id), colour);
      assert.ok(colour >= 0 && colour < AVATAR_COLOURS);
    }
  });

  test('uses the colour the user picked, and ignores invalid ones', () => {
    assert.equal(colourOf({ id: 'id-Work', color: 11 }), 11);
    assert.equal(colourOf({ id: 'id-Work', color: 0 }), 0);
    for (const color of [undefined, -1, 12, 2.5, NaN]) {
      assert.equal(colourOf({ id: 'id-Work', color }), avatarOf('id-Work'), String(color));
    }
  });

  test('accepts only well-formed webview messages', () => {
    assert.deepEqual(parseMessage({ type: 'add' }), { type: 'add' });
    assert.deepEqual(parseMessage({ type: 'switch', profileId: 'id-Work', extra: 1 }), { type: 'switch', profileId: 'id-Work' });
    assert.deepEqual(parseMessage({ type: 'signInCode', code: 'abc#123' }), { type: 'signInCode', code: 'abc#123' });
    assert.deepEqual(parseMessage({ type: 'setRenewal', profileId: 'id-Work' }), { type: 'setRenewal', profileId: 'id-Work' });
    assert.deepEqual(parseMessage({ type: 'openBilling', url: 'https://evil.example' }), { type: 'openBilling' });
    for (const type of ['copyLog', 'clearLog', 'openOutput']) {
      assert.deepEqual(parseMessage({ type }), { type });
    }
    // Dialog answers and notice clicks.
    assert.deepEqual(parseMessage({ type: 'promptResult', id: 'p1', value: 'Work' }), {
      type: 'promptResult',
      id: 'p1',
      value: 'Work',
      action: undefined,
    });
    assert.deepEqual(parseMessage({ type: 'promptResult', id: 'p1' }), { type: 'promptResult', id: 'p1', value: undefined, action: undefined });
    assert.deepEqual(parseMessage({ type: 'promptResult', id: 'p1', value: 'Work', color: 4 }), {
      type: 'promptResult',
      id: 'p1',
      value: 'Work',
      action: undefined,
      color: 4,
    });
    assert.deepEqual(parseMessage({ type: 'noticeAction', id: 'p2', action: 'switch' }), { type: 'noticeAction', id: 'p2', action: 'switch' });
    for (const bad of [
      { type: 'promptResult', id: '../x' },
      { type: 'promptResult', id: 'p1', value: 'x'.repeat(600) },
      { type: 'promptResult', id: 'p1', action: 'not an id' },
      { type: 'promptResult', id: 'p1', value: 'Work', color: 12 },
      { type: 'promptResult', id: 'p1', value: 'Work', color: '4' },
      { type: 'noticeAction' },
    ]) {
      assert.equal(parseMessage(bad), undefined, JSON.stringify(bad));
    }
    for (const bad of [
      null,
      'add',
      { type: 'deleteEverything' },
      { type: 'switch' },
      { type: 'remove', profileId: '../../etc/passwd' },
      { type: 'signInCode', code: '   ' },
      { type: 'signInCode', code: 'x'.repeat(600) },
    ]) {
      assert.equal(parseMessage(bad), undefined, JSON.stringify(bad));
    }
  });
});
