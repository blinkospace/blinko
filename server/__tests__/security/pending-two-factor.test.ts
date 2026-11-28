import { expect, test } from 'bun:test';
import { newPendingTwoFactor, pendingTwoFactor } from '../../../app/src/lib/pendingTwoFactor';

const challenge = 'a'.repeat(64);
const now = 1000000;
test('pending OAuth challenge survives storage serialization after URL scrubbing', () => {
  const pending = newPendingTwoFactor('42', challenge, now)!;
  const reloaded = JSON.parse(JSON.stringify(pending));
  expect(pendingTwoFactor(reloaded, now + 1000)).toEqual(pending);
  expect(pendingTwoFactor({ ...reloaded, token: 'old-session' }, now + 1000)).toEqual(pending);
  expect('token' in pendingTwoFactor(reloaded, now + 1000)!).toBe(false);
});
test('refresh cannot extend an expired challenge', () => {
  const pending = newPendingTwoFactor('42', challenge, now)!;
  expect(pendingTwoFactor(pending, pending.challengeExpiresAt)).toBeNull();
  expect(pendingTwoFactor(pending, now - 1)).toBeNull();
});
test.each([
  {},
  { requiresTwoFactor: true, user: { id: '42' } },
  { requiresTwoFactor: false, challenge, challengeExpiresAt: now + 100, user: { id: '42' } },
  { requiresTwoFactor: true, challenge: 'old-style', challengeExpiresAt: now + 100, user: { id: '42' } },
  { requiresTwoFactor: true, challenge, challengeExpiresAt: now + 100, user: { id: '0' } },
  { requiresTwoFactor: true, challenge, challengeExpiresAt: now + 100, user: { id: 'NaN' } },
  { requiresTwoFactor: true, challenge, challengeExpiresAt: now + 100, user: { id: '9007199254740992' } },
  { requiresTwoFactor: true, challenge, challengeExpiresAt: 'later', user: { id: '42' } },
])('incompatible pending state is rejected', (state) => {
  expect(pendingTwoFactor(state, now)).toBeNull();
});
