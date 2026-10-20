import * as assert from 'node:assert/strict';
import { isDateString, nextRenewal, parseUsageCache, PlanInfo, planOf } from '../../src/accountDetails';
import { SavedLogin } from '../../src/claudeFiles';
import { fakeAccount, fakeLogin, fakeUsageCache } from '../fixtures';

function loginWith(subscriptionType: string | undefined, rateLimitTier: string | undefined, account: object): SavedLogin {
  const credentials = JSON.parse(fakeLogin('A').credentialsRaw);
  credentials.claudeAiOauth.subscriptionType = subscriptionType;
  credentials.claudeAiOauth.rateLimitTier = rateLimitTier;
  return { credentialsRaw: JSON.stringify(credentials), account: { ...fakeAccount('A'), ...account } };
}

/** Local midnight, so the tests do not depend on the time zone. */
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();

suite('accountDetails', () => {
  test("reads Claude Code's cached usage", () => {
    const fetchedAt = Date.UTC(2026, 9, 20, 8);
    const usage = parseUsageCache({ cachedUsageUtilization: fakeUsageCache(fakeAccount('A'), fetchedAt, 42.4, 61) });
    assert.equal(usage?.accountUuid, 'acct-A');
    assert.equal(usage?.fetchedAt, fetchedAt);
    assert.equal(usage?.session?.percent, 42.4);
    assert.equal(usage?.weekly?.percent, 61);
    assert.equal(usage?.session?.resetsAt, new Date(fetchedAt + 3 * 3_600_000).toISOString());
    assert.equal(usage?.weeklyOpus, undefined);
  });

  test('treats an unexpected usage cache as no usage', () => {
    for (const config of [
      {},
      { cachedUsageUtilization: 'x' },
      { cachedUsageUtilization: { fetchedAtMs: 1, accountUuid: 'a' } },
      { cachedUsageUtilization: { fetchedAtMs: 1, accountUuid: 'a', utilization: { five_hour: { utilization: 'high' } } } },
    ]) {
      assert.equal(parseUsageCache(config), undefined, JSON.stringify(config));
    }
    const odd = parseUsageCache({
      cachedUsageUtilization: { fetchedAtMs: 1, accountUuid: 'a', utilization: { five_hour: { utilization: 140, resets_at: 'soon' } } },
    });
    assert.deepEqual(odd?.session, { percent: 100, resetsAt: undefined });
  });

  test('names plans from the token file and the organization type', () => {
    const cases: [SavedLogin, Partial<PlanInfo> | undefined][] = [
      [loginWith('team', 'default_raven', { organizationType: 'claude_team' }), { label: 'Team', personal: false }],
      [loginWith('max', 'default_claude_max_20x', { organizationType: 'claude_max' }), { label: 'Max 20x', personal: true }],
      [loginWith('max', undefined, {}), { label: 'Max', personal: true }],
      [loginWith('pro', undefined, {}), { label: 'Pro', personal: true }],
      [loginWith(undefined, undefined, { organizationType: 'claude_enterprise' }), { label: 'Enterprise', personal: false }],
      [loginWith(undefined, undefined, {}), undefined],
    ];
    for (const [login, expected] of cases) {
      const plan = planOf(login);
      assert.deepEqual(plan && { label: plan.label, personal: plan.personal }, expected);
    }
    assert.equal(planOf(loginWith('pro', undefined, { subscriptionCreatedAt: 'not a date' }))?.subscribedAt, undefined);
  });

  test('estimates a personal plan as renewing monthly on its start day', () => {
    const plan: PlanInfo = { label: 'Pro', personal: true, subscribedAt: '2025-01-31T10:00:00' };
    // The 31st falls on the last day of shorter months.
    assert.deepEqual(nextRenewal(plan, undefined, day(2026, 2, 10)), { date: '2026-02-28', estimated: true });
    assert.deepEqual(nextRenewal(plan, undefined, day(2026, 3, 1)), { date: '2026-03-31', estimated: true });
    // Never the start date itself.
    assert.deepEqual(nextRenewal(plan, undefined, day(2025, 1, 31)), { date: '2025-02-28', estimated: true });
  });

  test('prefers a date the user set, rolling it forward by its cycle', () => {
    const plan: PlanInfo = { label: 'Pro', personal: true, subscribedAt: '2025-01-31T10:00:00' };
    assert.deepEqual(nextRenewal(plan, { date: '2026-01-15', cycle: 'monthly' }, day(2026, 3, 20)), {
      date: '2026-04-15',
      estimated: false,
    });
    assert.deepEqual(nextRenewal(plan, { date: '2026-01-15', cycle: 'yearly' }, day(2026, 3, 20)), {
      date: '2027-01-15',
      estimated: false,
    });
    assert.equal(nextRenewal(plan, { date: '2026-03-20', cycle: 'monthly' }, day(2026, 3, 20))?.date, '2026-03-20');
  });

  test('does not estimate plans an organization pays for', () => {
    const team: PlanInfo = { label: 'Team', personal: false, subscribedAt: '2025-01-31T10:00:00' };
    assert.equal(nextRenewal(team, undefined, day(2026, 2, 10)), undefined);
    assert.equal(nextRenewal(team, { date: '2026-03-01', cycle: 'yearly' }, day(2026, 2, 10))?.date, '2026-03-01');
  });

  test('accepts only real calendar dates', () => {
    assert.ok(isDateString('2028-02-29'));
    for (const bad of ['2026-02-29', '2026-13-01', '2026-1-5', '15/01/2026', '']) {
      assert.equal(isDateString(bad), false, bad);
    }
  });
});
