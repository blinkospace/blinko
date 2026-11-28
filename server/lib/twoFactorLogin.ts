import { createHash, randomBytes } from "node:crypto";

type Store = {
  create(args: any): Promise<any>;
  findUnique(args: any): Promise<any>;
  updateMany(args: any): Promise<{ count: number }>;
  deleteMany(args: any): Promise<{ count: number }>;
};
export type TwoFactorAttempt = { id: string; userId: number; data: string };
const TTL = 5 * 60 * 1000;
const key = (token: string) =>
  `two-factor:${createHash("sha256").update(token).digest("hex")}`;

// Reuse the existing session table for cross-process, single-use challenges.
// Expiry cleanup happens only on a real first-factor login; no timer or idle query.
export class TwoFactorLogin {
  constructor(private store: Store) {}

  async issue(userId: number, now = Date.now()) {
    const token = randomBytes(32).toString("hex");
    const id = key(token);
    await this.store.deleteMany({
      where: {
        id: { startsWith: "two-factor:" },
        expiresAt: { lte: new Date(now) },
      },
    });
    await this.store.create({
      data: {
        id,
        sid: id,
        data: JSON.stringify({ userId, attempts: 0 }),
        expiresAt: new Date(now + TTL),
      },
    });
    return token;
  }

  async begin(
    token: unknown,
    userId: unknown,
    now = Date.now(),
  ): Promise<TwoFactorAttempt | null> {
    if (
      typeof token !== "string" ||
      !/^[a-f0-9]{64}$/.test(token) ||
      !Number.isSafeInteger(Number(userId)) ||
      Number(userId) <= 0
    )
      return null;
    const id = key(token);
    for (let retry = 0; retry < 3; retry++) {
      const record = await this.store.findUnique({ where: { id } });
      if (!record || record.expiresAt.getTime() <= now) return null;
      let state: { userId: number; attempts: number };
      try {
        state = JSON.parse(record.data);
      } catch {
        return null;
      }
      if (
        state.userId !== Number(userId) ||
        !Number.isInteger(state.attempts) ||
        state.attempts >= 5
      )
        return null;
      const data = JSON.stringify({
        userId: state.userId,
        attempts: state.attempts + 1,
      });
      const changed = await this.store.updateMany({
        where: { id, data: record.data, expiresAt: { gt: new Date(now) } },
        data: { data },
      });
      if (changed.count === 1) return { id, userId: state.userId, data };
    }
    return null;
  }

  async consume(attempt: TwoFactorAttempt) {
    const result = await this.store.deleteMany({
      where: {
        id: attempt.id,
        data: attempt.data,
        expiresAt: { gt: new Date() },
      },
    });
    return result.count === 1;
  }
}

// A bounded, request-driven IP limit protects storage even for bogus challenges.
export class TwoFactorRateLimit {
  private entries = new Map<string, { until: number; count: number }>();
  allow(ip: string, now = Date.now()) {
    if (this.entries.size >= 10000) {
      for (const [key, value] of this.entries)
        if (value.until <= now) this.entries.delete(key);
      if (!this.entries.has(ip) && this.entries.size >= 10000) return false;
    }
    let entry = this.entries.get(ip);
    if (!entry || entry.until <= now) {
      entry = { until: now + TTL, count: 0 };
      this.entries.set(ip, entry);
    }
    return ++entry.count <= 60;
  }
}
