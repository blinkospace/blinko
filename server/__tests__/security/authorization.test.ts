import { describe, test, expect, mock, beforeEach } from "bun:test";

let messages: any[];
let links: any[];
const conversations = [
  { id: 10, accountId: 1 },
  { id: 20, accountId: 2 },
];
const provider = {
  id: 1,
  title: "Provider",
  provider: "openai",
  baseURL: "https://example.com",
  apiKey: "TEST_KEY",
  config: { token: "SECRET" },
  models: [{ id: 1, config: { key: "SECRET" } }],
};
const model = {
  id: 1,
  title: "Model",
  modelKey: "test",
  capabilities: {},
  config: { token: "SECRET" },
  provider,
};
const matchConversation = (where: any) =>
  conversations.find(
    (c) => c.id === where.id && c.accountId === where.accountId,
  );
const matchMessage = (m: any, where: any) =>
  (!where.id || m.id === where.id) &&
  (!where.conversationId || m.conversationId === where.conversationId) &&
  (!where.conversation ||
    conversations.some(
      (c) =>
        c.id === m.conversationId &&
        c.accountId === where.conversation.accountId,
    ));
const updateProvider = mock(async () => provider);
const prisma: any = {
  conversation: {
    findFirst: async ({ where }: any) => matchConversation(where) || null,
  },
  message: {
    findFirst: async ({ where }: any) =>
      messages.find((m) => matchMessage(m, where)) || null,
    findMany: async ({ where }: any) =>
      messages.filter((m) => matchMessage(m, where)),
    count: async ({ where }: any) =>
      messages.filter((m) => matchMessage(m, where)).length,
    create: async ({ data }: any) => {
      const result = { ...data, id: 99 };
      messages.push(result);
      return result;
    },
    update: async ({ where, data }: any) => {
      const result = messages.find((m) => matchMessage(m, where));
      Object.assign(result, data);
      return result;
    },
    delete: async ({ where }: any) => {
      messages = messages.filter((m) => !matchMessage(m, where));
    },
    deleteMany: async ({ where }: any) => {
      const before = messages.length;
      messages = messages.filter(
        (m) =>
          !(
            matchMessage(m, where) &&
            (!where.createdAt || m.createdAt > where.createdAt.gt)
          ),
      );
      return { count: before - messages.length };
    },
  },
  accounts: {
    findFirst: async ({ where }: any) => ({
      id: where.id ?? 1,
      name: "user",
      nickname: "user",
      image: null,
      loginType: "",
      password: "stored-hash",
      role: where.id === 1 ? "superadmin" : "user",
    }),
    update: mock(async ({ where, data }: any) => {
      links.push({ id: where.id, ...data });
      return {};
    }),
    updateMany: mock(async ({ where }: any) => {
      links = links.filter((row) => row.linkAccountId !== where.linkAccountId);
      return { count: 1 };
    }),
  },
  aiProviders: {
    update: updateProvider,
    create: updateProvider,
    delete: updateProvider,
  },
  aiModels: {
    findMany: async () => [model],
    update: updateProvider,
    create: updateProvider,
    delete: updateProvider,
  },
  $transaction: async (fn: any) => fn(prisma),
};
mock.module("../../prisma", () => ({ prisma }));
let accountTwoFactor = false;
mock.module("../../routerTrpc/config", () => ({
  getGlobalConfig: async () => ({ twoFactorEnabled: accountTwoFactor }),
}));
mock.module("../../routerTrpc/note", () => ({ deleteNotes: async () => {} }));
mock.module("../../../prisma/seed", () => ({
  hashPassword: async () => "hash",
  verifyPassword: async (password: string) => password === "correct-password",
}));
mock.module("../../../prisma/seedData", () => ({ createSeed: async () => {} }));
mock.module("../../lib/helper", () => ({
  generateTOTP: () => "",
  generateTOTPQRCode: () => "",
  verifyTOTP: () => false,
  generateApiToken: () => "TEST_API_TOKEN",
  getAllPathTags: () => [],
}));
mock.module("../../aiServer", () => ({ AiService: {} }));
mock.module("../../aiServer/aiModelFactory", () => ({
  AiModelFactory: {
    getAllAiProviders: async () => [provider],
    getAiModelsByCapability: async () => [model],
  },
}));
mock.module("../../jobs/rebuildEmbeddingJob", () => ({
  RebuildEmbeddingJob: {},
}));
mock.module("../../lib/proxy", () => ({
  fetchWithProxy: () => {
    throw new Error("Unexpected network operation");
  },
}));

const { messageRouter } = await import("../../routerTrpc/message");
const { conversationRouter } = await import("../../routerTrpc/conversation");
const { userRouter } = await import("../../routerTrpc/user");
const { aiRouter } = await import("../../routerTrpc/ai");
const ctx = (id: number, role = "user") =>
  ({ id: String(id), sub: String(id), name: `user-${id}`, role }) as any;

beforeEach(() => {
  messages = [
    {
      id: 1,
      conversationId: 10,
      content: "owner secret",
      createdAt: new Date(1),
    },
    {
      id: 2,
      conversationId: 20,
      content: "other secret",
      createdAt: new Date(2),
    },
  ];
  links = [
    { id: 3, linkAccountId: 1 },
    { id: 4, linkAccountId: 2 },
  ];
  updateProvider.mockClear();
  accountTwoFactor = false;
});

describe("real tRPC message/conversation resolvers enforce ownership", () => {
  test.each(["list", "create", "update", "delete", "clearAfter"])(
    "cross-user message.%s leaves messages unchanged",
    async (operation) => {
      const caller: any = messageRouter.createCaller(ctx(1));
      const before = JSON.stringify(messages);
      const input =
        operation === "list"
          ? { conversationId: 20 }
          : operation === "create"
            ? {
                conversationId: 20,
                content: "injected",
                role: "user",
                metadata: {},
              }
            : { id: 2, content: "tampered" };
      await expect(caller[operation](input)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(JSON.stringify(messages)).toBe(before);
    },
  );
  test("owner can read/update, while another user cannot clear the conversation", async () => {
    const own = messageRouter.createCaller(ctx(1));
    expect((await own.list({ conversationId: 10 }))[0].content).toBe(
      "owner secret",
    );
    await own.update({ id: 1, content: "updated" });
    expect(messages[0].content).toBe("updated");
    await expect(
      conversationRouter.createCaller(ctx(2)).clearMessages({ id: 10 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(messages.length).toBe(2);
    await conversationRouter.createCaller(ctx(1)).clearMessages({ id: 10 });
    expect(messages.map((m) => m.id)).toEqual([2]);
  });
  test("even an administrator does not inherit another user’s private chat ownership", async () => {
    await expect(
      messageRouter
        .createCaller(ctx(1, "superadmin"))
        .list({ conversationId: 20 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("account linking requires target proof and unlinking is owner-scoped", () => {
  test.each(["", "wrong-password"])(
    "rejects password %j without linking",
    async (password) => {
      const before = JSON.stringify(links);
      await expect(
        userRouter
          .createCaller(ctx(2))
          .linkAccount({ id: 1, originalPassword: password }),
      ).rejects.toThrow();
      expect(JSON.stringify(links)).toBe(before);
    },
  );
  test("accepts valid target credentials and refuses self-linking", async () => {
    expect(
      await userRouter
        .createCaller(ctx(2))
        .linkAccount({ id: 1, originalPassword: "correct-password" }),
    ).toBe(true);
    expect(links).toContainEqual({ id: 2, linkAccountId: 1 });
    await expect(
      userRouter
        .createCaller(ctx(2))
        .linkAccount({ id: 2, originalPassword: "correct-password" }),
    ).rejects.toThrow();
  });
  test("cannot unlink someone else’s identities", async () => {
    await expect(
      userRouter.createCaller(ctx(2)).unlinkAccount({ id: 1 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(links.length).toBe(2);
    await userRouter.createCaller(ctx(2)).unlinkAccount({ id: 2 });
    expect(links).toEqual([{ id: 3, linkAccountId: 1 }]);
  });
});

describe("AI provider routes", () => {
  test("ordinary users can select models without seeing any key/config secrets", async () => {
    const caller = aiRouter.createCaller(ctx(2));
    const records = [
      await caller.getAllProviders(),
      await caller.getAllModels(),
      await caller.getModelsByProvider({ providerId: 1 }),
      await caller.getModelsByCapability({ capability: "inference" }),
    ];
    expect(JSON.stringify(records)).not.toContain("TEST_KEY");
    expect(JSON.stringify(records)).not.toContain("SECRET");
    expect((await caller.getAllModels())[0].modelKey).toBe("test");
    expect(
      (await aiRouter.createCaller(ctx(1, "superadmin")).getAllProviders())[0]
        .apiKey,
    ).toBe("TEST_KEY");
  });
  test.each([
    "createProvider",
    "updateProvider",
    "deleteProvider",
    "createModel",
    "updateModel",
    "deleteModel",
    "createModelsFromProvider",
    "batchCreateModelsFromProvider",
    "fetchProviderModels",
    "testConnect",
  ])(
    "ordinary user cannot call %s, before database/network side effects",
    async (operation) => {
      const caller: any = aiRouter.createCaller(ctx(2));
      await expect(caller[operation]({})).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      expect(updateProvider).not.toHaveBeenCalled();
    },
  );
  test("administrator can update a provider", async () => {
    await aiRouter
      .createCaller(ctx(1, "superadmin"))
      .updateProvider({ id: 1, title: "Updated" });
    expect(updateProvider).toHaveBeenCalledTimes(1);
  });
});

test("legacy user.login cannot bypass an account’s enabled second factor", async () => {
  accountTwoFactor = true;
  await expect(
    userRouter
      .createCaller({} as any)
      .login({ name: "user", password: "correct-password" }),
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  expect(links.length).toBe(2);
  accountTwoFactor = false;
  const result = await userRouter
    .createCaller({} as any)
    .login({ name: "user", password: "correct-password" });
  expect(result.token).toBe("TEST_API_TOKEN");
});
