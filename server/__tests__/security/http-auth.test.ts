import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  expect,
  test,
  mock,
} from "bun:test";
import express from "express";
import { authenticator } from "otplib";

const rows = new Map<string, any>();
let accountQueries = 0;
let tokenIssues = 0;
let enabled = true;
const secret = "JBSWY3DPEHPK3PXP";
const match = (row: any, where: any) =>
  (!where.id ||
    (typeof where.id === "string"
      ? row.id === where.id
      : row.id.startsWith(where.id.startsWith))) &&
  (!where.data || row.data === where.data) &&
  (!where.expiresAt?.gt || row.expiresAt > where.expiresAt.gt) &&
  (!where.expiresAt?.lte || row.expiresAt <= where.expiresAt.lte);
const session = {
  async create({ data }: any) {
    rows.set(data.id, { ...data });
    return data;
  },
  async findUnique({ where }: any) {
    return rows.has(where.id) ? { ...rows.get(where.id) } : null;
  },
  async updateMany({ where, data }: any) {
    const row = rows.get(where.id);
    if (!row || !match(row, where)) return { count: 0 };
    rows.set(where.id, { ...row, ...data });
    return { count: 1 };
  },
  async deleteMany({ where }: any) {
    let count = 0;
    for (const [id, row] of rows)
      if (match(row, where)) {
        rows.delete(id);
        count++;
      }
    return { count };
  },
};
mock.module("../../prisma", () => ({
  prisma: {
    session,
    accounts: {
      findUnique: async ({ where }: any) => {
        accountQueries++;
        return { id: where.id, name: "test-user", role: "user" };
      },
      update: async () => ({}),
    },
  },
}));
mock.module("../../routerExpress/auth/config", () => ({
  default: {
    authenticate:
      (_strategy: string, callback: any) => (req: any, _res: any, _next: any) =>
        callback(
          null,
          null,
          _strategy !== "local" || req.body.password === "correct"
            ? { requiresTwoFactor: true, userId: 1 }
            : { message: "Invalid credentials" },
        ),
  },
  ensureOAuthStrategies: async () => {},
}));
mock.module("../../routerTrpc/config", () => ({
  getGlobalConfig: async () => ({
    twoFactorEnabled: enabled,
    twoFactorSecret: secret,
  }),
}));
mock.module("../../lib/helper", () => ({
  verifyToken: async () => null,
  generateToken: async () => {
    tokenIssues++;
    return "TEST_SESSION";
  },
  generateApiToken: async () => "TEST_API",
}));
const { default: auth } = await import("../../routerExpress/auth");
let server: ReturnType<express.Express["listen"]>;
let origin: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", auth);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  rows.clear();
  accountQueries = 0;
  tokenIssues = 0;
  enabled = true;
});
const post = (route: string, body: any) =>
  fetch(origin + "/api/auth/" + route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const login = async () =>
  (await (
    await post("login", { username: "user", password: "correct" })
  ).json()) as any;

describe("real Express 2FA HTTP flow", () => {
  test("OAuth first-factor callbacks issue a challenge in the fragment, then require TOTP", async () => {
    const response = await fetch(origin + "/api/auth/callback/test-provider", {
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    const target = new URL(response.headers.get("location")!, origin);
    expect(target.search).toBe("");
    const params = new URLSearchParams(target.hash.slice(1));
    expect(params.get("requiresTwoFactor")).toBe("true");
    expect(params.get("challenge")).toMatch(/^[a-f0-9]{64}$/);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(tokenIssues).toBe(0);
    expect(
      (
        await post("verify-2fa", {
          userId: 1,
          code: authenticator.generate(secret),
          challenge: params.get("challenge"),
        })
      ).status,
    ).toBe(200);
  });
  test("valid TOTP alone cannot mint a token or query an account", async () => {
    const response = await post("verify-2fa", {
      userId: 1,
      code: authenticator.generate(secret),
    });
    expect(response.status).toBe(401);
    expect(accountQueries).toBe(0);
    expect(tokenIssues).toBe(0);
  });
  test("wrong first factor never issues a pending challenge", async () => {
    const response = await post("login", {
      username: "user",
      password: "wrong",
    });
    expect(response.status).toBe(401);
    expect(rows.size).toBe(0);
  });
  test("password challenge plus TOTP succeeds exactly once", async () => {
    const pending = await login();
    expect(pending.requiresTwoFactor).toBe(true);
    expect(pending.token).toBeUndefined();
    const body = {
      userId: 1,
      code: authenticator.generate(secret),
      challenge: pending.challenge,
    };
    expect((await post("verify-2fa", body)).status).toBe(200);
    expect((await post("verify-2fa", body)).status).toBe(401);
    expect(tokenIssues).toBe(1);
  });
  test("cannot substitute another user ID or use a challenge after 2FA is disabled", async () => {
    const pending = await login();
    expect(
      (
        await post("verify-2fa", {
          userId: 2,
          code: authenticator.generate(secret),
          challenge: pending.challenge,
        })
      ).status,
    ).toBe(401);
    expect(accountQueries).toBe(0);
    enabled = false;
    expect(
      (
        await post("verify-2fa", {
          userId: 1,
          code: authenticator.generate(secret),
          challenge: pending.challenge,
        })
      ).status,
    ).toBe(401);
    expect(tokenIssues).toBe(0);
  });
  test("five wrong codes exhaust the challenge even if the next code is correct", async () => {
    const pending = await login();
    const valid = authenticator.generate(secret);
    const wrong = valid === "000000" ? "999999" : "000000";
    for (let i = 0; i < 5; i++)
      expect(
        (
          await post("verify-2fa", {
            userId: 1,
            code: wrong,
            challenge: pending.challenge,
          })
        ).status,
      ).toBe(401);
    expect(
      (
        await post("verify-2fa", {
          userId: 1,
          code: valid,
          challenge: pending.challenge,
        })
      ).status,
    ).toBe(401);
    expect(accountQueries).toBe(5);
    expect(tokenIssues).toBe(0);
  });
  test("concurrent successful submissions cannot mint two sessions", async () => {
    const pending = await login();
    const responses = await Promise.all(
      [1, 2].map(() =>
        post("verify-2fa", {
          userId: 1,
          code: authenticator.generate(secret),
          challenge: pending.challenge,
        }),
      ),
    );
    expect(
      responses.filter((r) => r.status === 200).length,
    ).toBeLessThanOrEqual(1);
    expect(tokenIssues).toBeLessThanOrEqual(1);
  });
});
