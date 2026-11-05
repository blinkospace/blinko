// Pending first-factor state is deliberately separate from an authenticated session.
// The server remains authoritative for expiry, attempts, and single-use consumption.
const CHALLENGE_TTL = 5 * 60 * 1000;
export type PendingTwoFactor = {
  requiresTwoFactor: true;
  challenge: string;
  challengeExpiresAt: number;
  user: { id: string };
};

export function pendingTwoFactor(value: unknown, now = Date.now()): PendingTwoFactor | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Partial<PendingTwoFactor>;
  if (data.requiresTwoFactor !== true ||
      typeof data.challenge !== 'string' || !/^[a-f0-9]{64}$/.test(data.challenge) ||
      typeof data.user?.id !== 'string' || !/^[1-9]\d*$/.test(data.user.id) ||
      !Number.isSafeInteger(Number(data.user.id)) ||
      typeof data.challengeExpiresAt !== 'number' ||
      !Number.isFinite(data.challengeExpiresAt) ||
      data.challengeExpiresAt <= now || data.challengeExpiresAt > now + CHALLENGE_TTL) return null;
  return {
    requiresTwoFactor: true,
    challenge: data.challenge,
    challengeExpiresAt: data.challengeExpiresAt,
    user: { id: data.user.id },
  };
}

export function newPendingTwoFactor(userId: unknown, challenge: unknown, now = Date.now()) {
  return pendingTwoFactor({
    requiresTwoFactor: true,
    challenge,
    challengeExpiresAt: now + CHALLENGE_TTL,
    user: { id: String(userId) },
  }, now);
}
