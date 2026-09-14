import { describe, test, expect, mock, beforeEach } from 'bun:test';

/**
 * Regression test for issue #639.
 *
 * Signing in through an OAuth/SSO provider used to create a brand new account for any
 * unknown identity, even when "Allow register" was turned off. The OAuth callback now
 * applies the same rule as the password sign-up route: new accounts are only created
 * for the very first user or when registration is allowed. Existing OAuth accounts
 * must keep signing in regardless of the setting.
 *
 * Prisma and the token/config helpers are mocked so the real `handleOAuthCallback`
 * in `routerExpress/auth/config.ts` can be exercised without a database.
 */

const accountsFindFirst = mock((_args: any) => Promise.resolve(null as any));
const accountsCount = mock(() => Promise.resolve(0));
const accountsCreate = mock((args: any) => Promise.resolve({ id: 2, role: 'user', ...args.data }));
const accountsUpdate = mock((_args: any) => Promise.resolve({}));
const configFindFirst = mock((_args: any) => Promise.resolve(null as any));

mock.module('../../../prisma', () => ({
  prisma: {
    accounts: {
      findFirst: accountsFindFirst,
      count: accountsCount,
      create: accountsCreate,
      update: accountsUpdate,
    },
    config: { findFirst: configFindFirst },
  },
}));

mock.module('@prisma/seed', () => ({ verifyPassword: mock(() => Promise.resolve(false)) }));
mock.module('../../../routerTrpc/config', () => ({
  getGlobalConfig: mock(() => Promise.resolve({ twoFactorEnabled: false })),
}));
mock.module('../../../lib/helper', () => ({
  getNextAuthSecret: mock(() => Promise.resolve('secret')),
  generateToken: mock(() => Promise.resolve('token')),
  generateApiToken: mock(() => Promise.resolve('api-token')),
}));
mock.module('@shared/lib/cache', () => ({
  cache: {
    set: mock(() => {}),
    wrap: mock((_key: string, fn: () => any) => fn()),
  },
}));

const { handleOAuthCallback } = await import('../../../routerExpress/auth/config');

const profile = { id: 12345, username: 'new-sso-user', photos: [] };

const runCallback = () =>
  new Promise<{ err: any; user: any; info: any }>((resolve) => {
    handleOAuthCallback('access', 'refresh', profile, (err: any, user: any, info: any) =>
      resolve({ err, user, info }),
    );
  });

describe('handleOAuthCallback — issue #639', () => {
  beforeEach(() => {
    for (const m of [accountsFindFirst, accountsCount, accountsCreate, accountsUpdate, configFindFirst]) {
      m.mockClear();
    }
    accountsFindFirst.mockImplementation(() => Promise.resolve(null));
    accountsCount.mockImplementation(() => Promise.resolve(1));
    configFindFirst.mockImplementation(() => Promise.resolve(null));
  });

  test('does not create an account when registration is disabled', async () => {
    configFindFirst.mockImplementation(() =>
      Promise.resolve({ key: 'isAllowRegister', config: { value: false } }),
    );

    const { err, user, info } = await runCallback();

    expect(err).toBeNull();
    expect(user).toBe(false);
    expect(info).toEqual({ message: 'not allow register' });
    expect(accountsCreate).not.toHaveBeenCalled();
  });

  test('does not create an account when the setting was never saved', async () => {
    const { user } = await runCallback();

    expect(user).toBe(false);
    expect(accountsCreate).not.toHaveBeenCalled();
  });

  test('creates an account when registration is allowed', async () => {
    configFindFirst.mockImplementation(() =>
      Promise.resolve({ key: 'isAllowRegister', config: { value: true } }),
    );

    const { err, user } = await runCallback();

    expect(err).toBeNull();
    expect(accountsCreate).toHaveBeenCalledTimes(1);
    expect(user).toMatchObject({ name: 'new-sso-user', loginType: 'oauth', token: 'token' });
  });

  test('creates an account for the very first user, like the password sign-up', async () => {
    accountsCount.mockImplementation(() => Promise.resolve(0));

    const { user } = await runCallback();

    expect(accountsCreate).toHaveBeenCalledTimes(1);
    expect(user).toMatchObject({ name: 'new-sso-user', loginType: 'oauth' });
  });

  test('existing OAuth users can still sign in when registration is disabled', async () => {
    configFindFirst.mockImplementation(() =>
      Promise.resolve({ key: 'isAllowRegister', config: { value: false } }),
    );
    accountsFindFirst.mockImplementation(() =>
      Promise.resolve({ id: 7, name: 'new-sso-user', role: 'user', loginType: 'oauth', image: '', linkAccountId: null }),
    );

    const { err, user } = await runCallback();

    expect(err).toBeNull();
    expect(accountsCreate).not.toHaveBeenCalled();
    expect(user).toMatchObject({ id: 7, token: 'token' });
  });
});
