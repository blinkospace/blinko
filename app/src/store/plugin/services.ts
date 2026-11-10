/**
 * 插件服务 · 薄 SDK
 *
 * 设计要点：
 *  - 只依赖 shared 的纯 DTO，不引用 AppRouter，也不引用任何 server 模块，
 *    避免声明构建把服务端全图拉进来；
 *  - 传输由宿主注入，SDK 只管参数规范化、幂等键补齐和能力探测；
 *  - 不缓存会话或 token：每次调用都由宿主传输层取当前会话，
 *    避免切换账户后用旧身份发请求；
 *  - 对 shared 的引用写成相对路径而不是 `@shared/*`：本文件会进入发布的
 *    类型声明，别名会被原样写进 .d.ts，而外部消费者没有我们的 tsconfig
 *    paths，安装后就解析不到（构建成功、发布即坏）。
 */

import {
  PLUGIN_SERVICE_ERROR_CODES,
  PLUGIN_SERVICES_API_VERSION,
} from '../../../../shared/lib/pluginServices/v1';
import type {
  AbortLike,
  CallOptions,
  PluginHostContextSdk,
  PluginFilesSdk,
  CapabilityState,
  GenerateTextInput,
  GenerateTextResult,
  PluginServiceError,
  PluginServiceErrorCode,
  PluginServiceFeature,
  PluginServicesSdk,
  PublicModel,
  ServicesCapabilities,
  VectorIndexStatus,
  VectorQueryInput,
  VectorQueryResult,
  CreateVectorSnapshotInput,
  VectorSnapshotDescriptor,
  SampleVectorSnapshotInput,
  SampleVectorSnapshotResult,
  ReadVectorSnapshotInput,
  ReadVectorSnapshotResult,
  VectorSnapshotsSdk,
  NoteSnapshotReference,
  VectorAggregation,
} from '../../../../shared/lib/pluginServices/v1';

// 公共契约再导出。
// 声明文件里只 import 不 re-export，外部消费者就取不到这些类型，
// 只能去翻 dist 内部路径——那等于没有公开类型出口。
export type {
  AbortLike,
  CallOptions,
  PluginHostContextSdk,
  PluginFilesSdk,
  PluginHostContext,
  PluginFileUrlOptions,
  CapabilityState,
  CapabilityUnavailableReason,
  ChatMessage,
  ChatRole,
  FinishReason,
  GenerateTextInput,
  GenerateTextResult,
  IndexCoverage,
  IndexProvenance,
  NoteType,
  PluginServiceError,
  PluginServiceErrorCode,
  PluginServiceFeature,
  PluginServicesApiVersion,
  PluginServicesSdk,
  PublicModel,
  RetrievalAlgorithm,
  RetrievalMode,
  RetrievalTruncationReason,
  ServicesCapabilities,
  ServicesLimits,
  TokenUsage,
  VectorIndexStatus,
  VectorMatch,
  VectorQueryInput,
  VectorQueryItem,
  VectorQueryResult,
  CreateVectorSnapshotInput,
  VectorSnapshotDescriptor,
  SampleVectorSnapshotInput,
  SampleVectorSnapshotResult,
  ReadVectorSnapshotInput,
  ReadVectorSnapshotResult,
  VectorSnapshotsSdk,
  NoteSnapshotReference,
  VectorAggregation,
  VectorScope,
  VectorSource,
} from '../../../../shared/lib/pluginServices/v1';

export {
  PLUGIN_SERVICE_ERROR_CODES,
  PLUGIN_SERVICES_API_VERSION,
  PLUGIN_SERVICES_POLICY_LIMITS,
  PLUGIN_SERVICES_DEFAULT_OUTPUT_TOKENS,
  PLUGIN_SERVICES_MAX_MESSAGES,
  PLUGIN_SERVICES_MAX_CONTEXT_NOTES,
  VECTOR_SNAPSHOT_LIMITS,
} from '../../../../shared/lib/pluginServices/v1';

// ---------------------------------------------------------------------------
// 宿主传输接口
// ---------------------------------------------------------------------------

/**
 * 由宿主实现：把下列逻辑操作映射到实际的 tRPC procedure，并负责鉴权头、
 * 服务地址与取消信号。SDK 不假设具体 procedure 路径，宿主可以自由改名。
 */
export interface ServicesTransport {
  capabilities(options?: CallOptions): Promise<ServicesCapabilities>;
  vectorStatus(options?: CallOptions): Promise<VectorIndexStatus>;
  vectorQuery(input: VectorQueryInput, options?: CallOptions): Promise<VectorQueryResult>;
  listModels(options?: CallOptions): Promise<PublicModel[]>;
  generateText(input: GenerateTextInput, options?: CallOptions): Promise<GenerateTextResult>;
  createSnapshot?(input: CreateVectorSnapshotInput, options?: CallOptions): Promise<VectorSnapshotDescriptor>;
  sampleSnapshot?(input: SampleVectorSnapshotInput, options?: CallOptions): Promise<SampleVectorSnapshotResult>;
  readSnapshotNote?(input: ReadVectorSnapshotInput, options?: CallOptions): Promise<ReadVectorSnapshotResult>;
  releaseSnapshot?(input: { handle: string }, options?: CallOptions): Promise<void>;
}

// ---------------------------------------------------------------------------
// 参数规范化
// ---------------------------------------------------------------------------

let idempotencyCounter = 0;

/**
 * 生成幂等键。优先用 crypto.randomUUID；不可用时退化为时间戳+计数+随机数。
 * 明确不用 Math.random 单独作键：碰撞会让两个不同的付费调用被判为同一次。
 */
export function createIdempotencyKey(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoRef?.randomUUID === 'function') {
    return cryptoRef.randomUUID();
  }
  idempotencyCounter += 1;
  const random = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `ps-${Date.now().toString(36)}-${idempotencyCounter.toString(36)}-${random}`;
}

/**
 * 向量查询的参数规范化：
 *  - 文本查询会产生 Embedding 费用，缺幂等键时补一个，保证"同一逻辑调用"
 *    可以显式复用；补齐不改变调用语义。
 *  - 按笔记查询不产生付费调用，显式传入的幂等键会被丢弃，
 *    避免调用方误以为它有意义。
 */
export function normalizeVectorQuery(input: VectorQueryInput): VectorQueryInput {
  if (input.source.kind === 'text') {
    return input.idempotencyKey ? input : { ...input, idempotencyKey: createIdempotencyKey() };
  }
  if (input.idempotencyKey === undefined) {
    return input;
  }
  const { idempotencyKey: _ignored, ...rest } = input;
  return rest;
}

/**
 * 生成参数规范化：幂等键必填，但空串一律当作缺失并补一个，
 * 免得空串被服务端当成合法键、把不同调用串成一次。
 */
export function normalizeGenerateText(input: GenerateTextInput): GenerateTextInput {
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.trim() !== '') {
    return input;
  }
  return { ...input, idempotencyKey: createIdempotencyKey() };
}

// ---------------------------------------------------------------------------
// 能力探测辅助
// ---------------------------------------------------------------------------

export class PluginServiceUnavailableError extends Error {
  readonly feature: PluginServiceFeature;
  readonly state: CapabilityState;

  constructor(feature: PluginServiceFeature, state: CapabilityState) {
    super(
      `plugin service feature "${feature}" is unavailable${state.reason ? ` (${state.reason})` : ''}`,
    );
    this.name = 'PluginServiceUnavailableError';
    this.feature = feature;
    this.state = state;
  }
}

/**
 * 调用前探测能力。方法存在不等于服务可运行，因此必须显式调用而不是
 * 直接 try/catch 一个失败请求——后者分不清"不支持"和"这次出错了"。
 */
export function requireCapability(
  capabilities: ServicesCapabilities,
  feature: PluginServiceFeature,
): void {
  const state = capabilities.features[feature] ?? { available: false, reason: 'unsupported' as const };
  if (!state.available) {
    throw new PluginServiceUnavailableError(feature, state);
  }
}

// ---------------------------------------------------------------------------
// SDK 工厂
// ---------------------------------------------------------------------------

/**
 * 构造插件侧 SDK。宿主在挂载 window.Blinko.services 时调用一次即可；
 * 传输对象必须每次调用都取当前会话，不得在内部缓存 token。
 */
/** Optional local browser capabilities; kept separate from the server transport. */
export interface PluginHostBindings {
  readonly context: PluginHostContextSdk;
  readonly files: PluginFilesSdk;
  run<T>(invoke: (options: CallOptions) => Promise<T>, options?: CallOptions): Promise<T>;
}

export function createPluginServices(transport: ServicesTransport, host?: PluginHostBindings): PluginServicesSdk {
  const call = <T>(invoke: (options?: CallOptions) => Promise<T>, options?: CallOptions): Promise<T> =>
    host ? host.run(invoke, options) : invoke(options);
  return {
    apiVersion: PLUGIN_SERVICES_API_VERSION,
    ...(host ? { context: host.context, files: host.files } : {}),
    capabilities: (options) => call(async current => {
      const capabilities = await transport.capabilities(current);
      return host ? { ...capabilities, features: { ...capabilities.features,
        'host.context': { available: true }, 'files.url': { available: true } } } : capabilities;
    }, options),
    vector: {
      status: (options) => call(current => transport.vectorStatus(current), options),
      query: (input, options) => call(current => transport.vectorQuery(normalizeVectorQuery(input), current), options),
      snapshots: {
        create: (input, options) => call(current => transport.createSnapshot ? transport.createSnapshot(input, current) : Promise.reject(missing('vector.snapshots')), options),
        sample: (input, options) => call(current => transport.sampleSnapshot ? transport.sampleSnapshot(input, current) : Promise.reject(missing('vector.snapshots')), options),
        readNote: (input, options) => call(current => transport.readSnapshotNote ? transport.readSnapshotNote(input, current) : Promise.reject(missing('vector.snapshots')), options),
        release: (input, options) => call(current => transport.releaseSnapshot ? transport.releaseSnapshot(input, current) : Promise.reject(missing('vector.snapshots')), options),
      },
    },
    ai: {
      listModels: (options) => call(current => transport.listModels(current), options),
      generateText: (input, options) => call(current => transport.generateText(normalizeGenerateText(input), current), options),
    },
  };
}

// ---------------------------------------------------------------------------
// 宿主适配：把 tRPC 客户端接到 SDK 的传输接口
// ---------------------------------------------------------------------------

/**
 * 宿主 procedure 的调用选项。
 *
 * 这里用 AbortLike 而不是 DOM 的 AbortSignal：这两个类型会进入发布出去的
 * .d.ts，而 SDK 的消费者未必开 DOM lib（Node 脚本、构建工具里很常见）。
 * 之前写 AbortSignal 会在打包后的声明检查阶段直接报"找不到 AbortSignal"。
 * DOM 的 AbortSignal 结构上满足 AbortLike，所以真实 tRPC 客户端仍可传入。
 */
type HostProcedureOptions = { signal?: AbortLike };

type QueryProcedure<O> = {
  query(input?: undefined, opts?: HostProcedureOptions): Promise<O>;
};
type MutationProcedure<I, O> = {
  mutate(input: I, opts?: HostProcedureOptions): Promise<O>;
};

/**
 * 宿主侧插件的实际形状。刻意只声明本 SDK 用到的那几个 procedure，
 * 不引用 AppRouter——否则声明构建会把服务端全图拉进来（这正是旧类型包
 * OOM 的原因之一）。
 */
export interface PluginServicesTrpcShape {
  pluginServices?: {
    capabilities?: QueryProcedure<ServicesCapabilities>;
    vector?: {
      status?: QueryProcedure<VectorIndexStatus>;
      query?: MutationProcedure<VectorQueryInput, VectorQueryResult>;
      snapshots?: {
        create?: MutationProcedure<CreateVectorSnapshotInput, VectorSnapshotDescriptor>;
        sample?: MutationProcedure<SampleVectorSnapshotInput, SampleVectorSnapshotResult>;
        readNote?: MutationProcedure<ReadVectorSnapshotInput, ReadVectorSnapshotResult>;
        release?: MutationProcedure<{ handle: string }, void>;
      };
    };
    ai?: {
      listModels?: QueryProcedure<PublicModel[]>;
      generateText?: MutationProcedure<GenerateTextInput, GenerateTextResult>;
    };
  };
}

/**
 * 只做选项转手，不做类型强转。
 *
 * 我们的 procedure 形状本身就按 HostProcedureOptions 声明，所以这里返回同一
 * 形状即可，不需要 `as unknown as AbortSignal` 那种硬转——硬转会在没有 DOM 的
 * 消费者那里暴露成"找不到 AbortSignal"，而且把不兼容藏进类型断言里。
 */
function trpcOptions(options?: CallOptions): HostProcedureOptions {
  return { signal: options?.signal };
}

function missing(feature: PluginServiceFeature): PluginServiceUnavailableError {
  return new PluginServiceUnavailableError(feature, { available: false, reason: 'unsupported' });
}

/** 服务端返回的结构化错误（经 tRPC 的 message 字段承载）。 */
export class PluginServiceCallError extends Error {
  readonly code: PluginServiceErrorCode;
  readonly requestId: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(dto: PluginServiceError) {
    super(dto.message);
    this.name = 'PluginServiceCallError';
    this.code = dto.code;
    this.requestId = dto.requestId;
    this.retryable = dto.retryable;
    this.retryAfterMs = dto.retryAfterMs;
  }
}

/**
 * 把失败翻译成插件能理解的东西。
 *
 * 这里有个坑，实测过：tRPC 客户端是**动态 Proxy**，未挂载的端点取属性时
 * 不会返回 undefined，而是返回函数（`.query`/`.mutate` 也是函数）。
 * 所以"取不到就判不支持"在真实客户端上永远不成立——真正的信号是调用之后
 * 抛出的 TRPCClientError，其 `data.code === 'NOT_FOUND'`。
 *
 * 另外服务端把我们自己的错误 DTO 塞在 TRPCError 的 message 里，
 * 这里解出来还原成强类型错误，别让调用方去 parse 字符串。
 */
function translateFailure(feature: PluginServiceFeature, error: unknown): unknown {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === 'string') {
    const dto = decodeServiceError(message);
    if (dto) return new PluginServiceCallError(dto);
  }
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code;
  if (code === 'NOT_FOUND') return missing(feature);
  // Authentication/permission guards run before the service DTO middleware.
  // Keep their failures in the same public error vocabulary for plugin cleanup.
  if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') return new PluginServiceCallError({
    code: code === 'UNAUTHORIZED' ? 'UNAUTHENTICATED' : 'FORBIDDEN',
    requestId: createIdempotencyKey(),
    message: code === 'UNAUTHORIZED' ? 'Authentication required.' : 'Service permission required.',
    retryable: false,
  });
  return error;
}

/**
 * 解析服务端错误信封。
 *
 * 不采用"有 code 和 requestId 就当 DTO"的宽松做法：任何字符串都能冒充 code，
 * 一旦接受未知码，调用方会拿到一个它不认识的错误分支，比拿到原始异常更糟。
 * 这里逐字段校验，且 code 必须落在运行时清单里。
 */
export function decodeServiceError(message: string): PluginServiceError | null {
  let candidate: unknown;
  try {
    candidate = JSON.parse(message);
  } catch {
    return null;
  }
  if (typeof candidate !== 'object' || candidate === null) return null;
  const value = candidate as Record<string, unknown>;
  if (typeof value.code !== 'string') return null;
  if (!(PLUGIN_SERVICE_ERROR_CODES as readonly string[]).includes(value.code)) return null;
  if (typeof value.requestId !== 'string' || value.requestId.length === 0) return null;
  if (typeof value.message !== 'string') return null;
  if (typeof value.retryable !== 'boolean') return null;
  if (value.retryAfterMs !== undefined) {
    if (typeof value.retryAfterMs !== 'number' || !Number.isFinite(value.retryAfterMs)) return null;
  }
  return {
    code: value.code as PluginServiceErrorCode,
    requestId: value.requestId,
    message: value.message,
    retryable: value.retryable,
    ...(value.retryAfterMs === undefined ? {} : { retryAfterMs: value.retryAfterMs as number }),
  };
}

async function callService<T>(
  feature: PluginServiceFeature,
  invoke: () => Promise<T>,
): Promise<T> {
  try {
    return await invoke();
  } catch (error) {
    throw translateFailure(feature, error);
  }
}

/**
 * 构造宿主传输层。传入的是**取客户端的函数**而不是客户端本身：
 * `api` 在登录/登出时会被重新赋值（见 lib/trpc.ts 的 reinitializeTrpcApi），
 * 捕获一次就会在切换账户后继续用旧 token 发请求。
 *
 * 注意：`clientTag` 目前不会上传——服务端还没有对应的归因字段。
 * 这里明确不做"假装发了"，插件也不该指望它能带来任何授权效果。
 */
export function createPluginServicesTransport(
  getClient: () => PluginServicesTrpcShape,
): ServicesTransport {
  return {
    async capabilities(options) {
      const procedure = getClient().pluginServices?.capabilities;
      if (!procedure) throw missing('ai.generateText'); // 服务整体未挂载
      return callService('ai.generateText', () => procedure.query(undefined, trpcOptions(options)));
    },
    async vectorStatus(options) {
      const procedure = getClient().pluginServices?.vector?.status;
      if (!procedure) throw missing('vector.status');
      return callService('vector.status', () => procedure.query(undefined, trpcOptions(options)));
    },
    async vectorQuery(input, options) {
      const procedure = getClient().pluginServices?.vector?.query;
      if (!procedure) throw missing('vector.queryByNote');
      return callService('vector.queryByNote', () =>
        procedure.mutate(input, trpcOptions(options)),
      );
    },
    async createSnapshot(input, options) {
      const procedure = getClient().pluginServices?.vector?.snapshots?.create;
      if (!procedure) throw missing('vector.snapshots');
      return callService('vector.snapshots', () => procedure.mutate(input, trpcOptions(options)));
    },
    async sampleSnapshot(input, options) {
      const procedure = getClient().pluginServices?.vector?.snapshots?.sample;
      if (!procedure) throw missing('vector.snapshots');
      return callService('vector.snapshots', () => procedure.mutate(input, trpcOptions(options)));
    },
    async readSnapshotNote(input, options) {
      const procedure = getClient().pluginServices?.vector?.snapshots?.readNote;
      if (!procedure) throw missing('vector.snapshots');
      return callService('vector.snapshots', () => procedure.mutate(input, trpcOptions(options)));
    },
    async releaseSnapshot(input, options) {
      const procedure = getClient().pluginServices?.vector?.snapshots?.release;
      if (!procedure) throw missing('vector.snapshots');
      return callService('vector.snapshots', () => procedure.mutate(input, trpcOptions(options)));
    },
    async listModels(options) {
      const procedure = getClient().pluginServices?.ai?.listModels;
      if (!procedure) throw missing('ai.listModels');
      return callService('ai.listModels', () => procedure.query(undefined, trpcOptions(options)));
    },
    async generateText(input, options) {
      const procedure = getClient().pluginServices?.ai?.generateText;
      if (!procedure) throw missing('ai.generateText');
      return callService('ai.generateText', () =>
        procedure.mutate(input, trpcOptions(options)),
      );
    },
  };
}
