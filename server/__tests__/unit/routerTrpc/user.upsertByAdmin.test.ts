import { beforeEach, expect, mock, test } from 'bun:test';
import { z } from 'zod';

const create = mock(async (_args: any) => ({ id: 12 }));
const update = mock(async (_args: any) => ({}));
const hashPassword = mock(async (_password: string) => 'hashed');
const prisma: any = {
  $transaction: async (fn: any) => fn(prisma),
  accounts: { create, update, findFirst: async () => null, findUnique: async () => ({ name: 'existing' }) },
};
mock.module('../../../prisma', () => ({ prisma }));
mock.module('@trpc/server', () => ({ TRPCError: class extends Error {
  code: string;
  constructor({ code, message }: any) { super(message); this.code = code; }
} }));
function procedure(schema?: any): any {
  const builder: any = {};
  for (const key of ['use', 'meta', 'output']) builder[key] = () => builder;
  builder.input = (input: any) => procedure(input);
  builder.query = builder.mutation = (resolver: any) => ({
    call: (input: any) => resolver({ input: schema.parse(input), ctx: { id: '1', role: 'superadmin' } }),
  });
  return builder;
}
mock.module('../../../middleware', () => ({
  router: (routes: any) => routes, publicProcedure: procedure(), authProcedure: procedure(),
  superAdminAuthMiddleware: () => {}, demoAuthMiddleware: () => {},
}));
mock.module('@shared/lib/prismaZodType', () => ({ accountsSchema: z.any() }));
mock.module('../../../../prisma/seed', () => ({ hashPassword, verifyPassword: () => true }));
mock.module('../../../lib/helper', () => ({
  generateTOTP: () => '', generateTOTPQRCode: () => '', verifyTOTP: () => false,
  generateApiToken: () => 'test-token',
}));
mock.module('../../../routerTrpc/note', () => ({ deleteNotes: () => {} }));
mock.module('../../../../prisma/seedData', () => ({ createSeed: () => {} }));
mock.module('../../../routerTrpc/config', () => ({ getGlobalConfig: () => ({}) }));

const { userRouter } = await import('../../../routerTrpc/user');
const upsert = (input: any) => (userRouter as any).upsertUserByAdmin.call(input);
beforeEach(() => { create.mockClear(); update.mockClear(); hashPassword.mockClear(); });

for (const name of [undefined, '', '   ', '\t\n']) {
  test(`creation rejects blank username ${JSON.stringify(name)} before any writes`, async () => {
    await expect(upsert({ name, password: 'test-password' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(hashPassword).not.toHaveBeenCalled();
  });
}
test('creation with a username succeeds and uses it as default nickname', async () => {
  expect(await upsert({ name: 'new-user', password: 'test-password' })).toBe(true);
  expect(create).toHaveBeenCalledWith({ data: { name: 'new-user', password: 'hashed', nickname: 'new-user', role: 'user' } });
});
test('partial password update does not require a username', async () => {
  expect(await upsert({ id: 12, password: 'replacement' })).toBe(true);
  expect(update).toHaveBeenCalledWith({ where: { id: 12 }, data: { password: 'hashed' } });
  expect(create).not.toHaveBeenCalled();
});
test('partial nickname update does not require a username', async () => {
  expect(await upsert({ id: 12, nickname: 'new nickname' })).toBe(true);
  expect(update).toHaveBeenCalledWith({ where: { id: 12 }, data: { nickname: 'new nickname' } });
});
for (const name of ['', ' \t ']) {
  test(`update rejects explicitly blank username ${JSON.stringify(name)}`, async () => {
    await expect(upsert({ id: 12, name })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(update).not.toHaveBeenCalled();
  });
}
