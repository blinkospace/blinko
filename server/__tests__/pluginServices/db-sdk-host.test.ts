import { afterAll, describe, expect, test } from 'bun:test';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import superjson from 'superjson';
import { prisma } from '../../prisma';
import { appRouter, type AppRouter } from '../../routerTrpc/_app';
import type { User } from '../../context';
import {
  PluginServiceUnavailableError,
  createPluginServices,
  createPluginServicesTransport,
  decodeServiceError,
} from '../../../app/src/store/plugin/services';
import { PLUGIN_SERVICES_API_VERSION } from '@shared/lib/pluginServices/v1';

// 与其它 db-* 套件同一守卫：没有专用真实 PostgreSQL 就直接失败，不跳过、不模拟。
if (process.env.PLUGIN_SERVICES_TEST_DB !== '1' || !process.env.DATABASE_URL)
  throw new Error('An isolated real PostgreSQL database is required.');
const url = new URL(process.env.DATABASE_URL);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.username !== 'blinko_test')
  throw new Error('Wrong test database.');

// 合成上下文：与真实登录用户同形状，不读取任何真实账户。
const syntheticUser: User = {
  id: '1',
  sub: '1',
  name: 'synthetic-host-user',
  role: 'superadmin',
  exp: 0,
  iat: 0,
  ip: '127.0.0.1',
  userAgent: null,
};

/**
 * 真实 tRPC HTTP 链路，但不监听端口：把构造出来的 Request 直接交给
 * fetchRequestHandler，拿回真实的 Response。
 *
 * 这样得到的是**真实的客户端 Proxy、真实的 httpBatchLink、真实的错误格式**，
 * 而不是我上一版那种手搓的假 procedure 和假 NOT_FOUND。
 */
function fetchThroughHandler(request: Request): Promise<Response> {
  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req: request,
    router: appRouter,
    createContext: () => syntheticUser,
  });
}

const client = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: 'http://plugin-services.test/api/trpc',
      transformer: superjson,
      fetch: (input, init) => fetchThroughHandler(new Request(String(input), init)),
    }),
  ],
});

const sdk = createPluginServices(createPluginServicesTransport(() => client));

afterAll(async () => {
  await prisma.$disconnect();
});

describe('SDK 经真实 appRouter + httpBatchLink 调用宿主', () => {
  test('capabilities 返回真实路由响应', async () => {
    const capabilities = await sdk.capabilities();
    expect(capabilities.apiVersion).toBe(PLUGIN_SERVICES_API_VERSION);
    expect(capabilities.hostVersion).toBeTruthy();
    expect(capabilities.limits.maxResults).toBeGreaterThan(0);
    expect(capabilities.features['vector.status']).toBeDefined();
  });

  test('vector.status 返回真实索引状态且字段完整', async () => {
    const status = await sdk.vector.status();
    expect(typeof status.available).toBe('boolean');
    expect(['ready', 'partial', 'unknown']).toContain(status.coverage);
    if (!status.available) expect(status.reason).toBeTruthy();
  });

  test('已挂载的 AI 目录经真实链路返回空目录，未配置生成模型时不冒称可用', async () => {
    expect(await sdk.ai.listModels()).toEqual([]);
    expect((await sdk.capabilities()).features['ai.generateText']).toEqual({ available: false, reason: 'not-configured' });
  });

  test('能力发现与实际调用一致：报告不可用的功能调用应失败', async () => {
    const capabilities = await sdk.capabilities();
    expect(capabilities.features['ai.generateText']?.available).toBe(false);
    await expect(
      sdk.ai.generateText({ messages: [{ role: 'user', content: 'x' }], idempotencyKey: 'k' }),
    ).rejects.toThrow();
  });
});

describe('服务端错误信封经真实链路可被解析', () => {
  test('客户端传错参数时返回的是结构化错误，不是裸字符串', async () => {
    const adminClient = (client as unknown as {
      pluginServices: {
        admin: { setPolicy: { mutate(input: unknown): Promise<unknown> } };
      };
    }).pluginServices.admin;

    const failure = await adminClient.setPolicy
      .mutate({ limits: { maxResults: 'many' } })
      .catch((error) => error);

    const message = (failure as { message?: string })?.message ?? '';
    const dto = decodeServiceError(message);
    expect(dto).not.toBeNull();
    expect(dto?.requestId.length).toBeGreaterThan(0);
    expect(dto?.code).toBe('INVALID_INPUT');
    expect(dto?.retryable).toBe(false);
  });
});
