import { test, expect } from "bun:test";
import { router } from "../../middleware";
import { z } from 'zod';
import { toPublicError } from "../../services/pluginServices/errors";
test("unknown internal failures do not masquerade as provider errors", () => {
  expect(toPublicError(new Error("synthetic database failure"))).toMatchObject({
    code: "INTERNAL_ERROR",
    retryable: false,
  });
});
import {
  serviceProcedure,
  hasServicePermission,
} from "../../services/pluginServices/procedure";

const app = router({
  pluginServices: router({
    ai: router({
      listModels: serviceProcedure("ai.listModels").query(() => []),
    }),
  }),
});
const ctx = { id: "1", sub: "1", name: "synthetic", role: "user" };
for (const permissions of [
  [],
  [""],
  ["plugin"],
  ["ai"],
  ["note"],
  ["pluginServices.ai.list"],
]) {
  test(`restricted token rejects substring permissions ${JSON.stringify(permissions)}`, async () => {
    await expect(
      app
        .createCaller({ ...ctx, permissions } as never)
        .pluginServices.ai.listModels(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
}
for (const permissions of [
  undefined,
  ["pluginServices"],
  ["pluginServices.ai"],
  ["pluginServices.ai.listModels"],
]) {
  test(`explicit permission grants exact service path ${JSON.stringify(permissions)}`, async () => {
    expect(
      await app
        .createCaller({ ...ctx, permissions } as never)
        .pluginServices.ai.listModels(),
    ).toEqual([]);
  });
}
test("permission guard follows procedure to an unexpected mount", async () => {
  const second = router({
    other: router({
      listModels: serviceProcedure("ai.listModels").query(() => []),
    }),
  });
  await expect(
    second.createCaller(ctx as never).other.listModels(),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});
test("anonymous and pending second factor cannot call services", async () => {
  await expect(
    app.createCaller({} as never).pluginServices.ai.listModels(),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  await expect(
    app
      .createCaller({ ...ctx, requiresTwoFactor: true } as never)
      .pluginServices.ai.listModels(),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});
test('Zod validation is INVALID_INPUT and a handler failure remains INTERNAL_ERROR', async () => {
  let invocations = 0;
  const route = router({ pluginServices: router({ admin: router({
    setPolicy: serviceProcedure('admin.setPolicy').input(z.object({ maxResults: z.number() })).mutation(() => {
      invocations++;
      throw new Error('synthetic private database detail');
    }),
  }) }) });
  const caller = route.createCaller({ ...ctx, role: 'superadmin' } as never);
  for (const [value, code] of [['invalid', 'INVALID_INPUT'], [1, 'INTERNAL_ERROR']] as const) {
    const error = await caller.pluginServices.admin.setPolicy({ maxResults: value as number }).catch(error => error);
    expect(JSON.parse(error.message)).toMatchObject({ code, retryable: false });
    expect(error.message).not.toContain('synthetic private database detail');
  }
  expect(invocations).toBe(1);
});

test("malformed permission data fails closed", () => {
  expect(hasServicePermission(null, "pluginServices.ai.listModels")).toBe(
    false,
  );
});
