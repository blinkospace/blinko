/**
 * Blinko 通用插件服务 · 公共契约 v1
 *
 * 纯类型与常量模块：只描述线上传输的 DTO、能力状态与错误码。
 * 公共契约约束：
 *  - 不导出 Prisma 类型、供应商 SDK 类型或任何服务端内部对象；
 *  - 不引入 DOM / 运行时依赖，服务端与客户端共用同一份声明；
 *  - 服务端私有类型（BodyRevision、AuthorizedNoteSnapshot 等）不得出现在此文件。
 */

/** 插件服务 API 主版本，独立于应用版本。 */
export const PLUGIN_SERVICES_API_VERSION = '1.0' as const;

export type PluginServicesApiVersion = typeof PLUGIN_SERVICES_API_VERSION;

// ---------------------------------------------------------------------------
// 能力发现
// ---------------------------------------------------------------------------

/** 能力不可用的原因。方法存在不代表服务可运行。 */
export type CapabilityUnavailableReason =
  | 'unsupported'
  | 'disabled'
  | 'forbidden'
  | 'not-configured'
  | 'index-not-ready';

export interface CapabilityState {
  available: boolean;
  /** available 为 false 时必填；为 true 时不应出现。 */
  reason?: CapabilityUnavailableReason;
}

/**
 * 能力键名固定，便于插件做能力探测而不用猜宿主版本。
 * 只读向量服务与会产生外部调用的文本查询分开报告。
 */
export type PluginServiceFeature =
  | 'host.context'
  | 'files.url'
  | 'vector.status'
  | 'vector.queryByNote'
  | 'vector.queryByText'
  | 'vector.exact'
  | 'vector.approximate'
  | 'vector.noteLevelAggregation'
  | 'vector.snapshots'
  | 'ai.listModels'
  | 'ai.generateText';

/** 策略限值。首次实现即返回真实生效值；不是性能基准的实测结果。 */
export interface ServicesLimits {
  maxResults: number;
  maxExcludeIds: number;
  maxInputBytes: number;
  maxOutputTokens: number;
  maxConcurrentGeneration: number;
}

export interface ServicesCapabilities {
  apiVersion: PluginServicesApiVersion;
  /** 宿主应用版本，仅供展示与排障，插件不得据此推断能力。 */
  hostVersion: string;
  features: Partial<Record<PluginServiceFeature, CapabilityState>>;
  limits: ServicesLimits;
  /** Logical snapshot payload/count limits; not a process-RSS or database-file cap. */
  vectorSnapshotLimits?: typeof VECTOR_SNAPSHOT_LIMITS;
}

/**
 * 策略限值的单一来源。capabilities 与各 procedure 的输入校验都从这里取值，
 * 避免契约报一个上限、路由收另一个上限。
 *
 * 这些是策略默认值，不是性能基准结果；管理员策略与具体模型可进一步收紧。
 * 性能基准用于调整数字，不作为省略字段的理由。
 */
export const PLUGIN_SERVICES_POLICY_LIMITS: Readonly<ServicesLimits> = Object.freeze({
  maxResults: 50,
  maxExcludeIds: 5000,
  maxInputBytes: 262144,
  maxOutputTokens: 8192,
  maxConcurrentGeneration: 2,
});

/** 单次生成未显式指定时的输出上限。 */
export const PLUGIN_SERVICES_DEFAULT_OUTPUT_TOKENS = 2048;

/** 单次生成的上下文笔记条数与消息条数上限。 */
export const PLUGIN_SERVICES_MAX_MESSAGES = 64;
export const PLUGIN_SERVICES_MAX_CONTEXT_NOTES = 64;

// ---------------------------------------------------------------------------
// 向量检索
// ---------------------------------------------------------------------------

/** 宿主笔记类型：0 闪念、1 笔记、2 其他。 */
export type NoteType = 0 | 1 | 2;

export type VectorSource =
  | { kind: 'note'; noteId: number }
  | { kind: 'text'; text: string };

export interface VectorScope {
  /** 默认 [0, 1]。 */
  types?: NoteType[];
  /** 默认 false。回收站永不开放。 */
  includeArchived?: boolean;
  tagIds?: number[];
  tagMatch?: 'any' | 'all';
  /** 含时区 ISO 8601，含端点。 */
  createdFrom?: string;
  /** 含时区 ISO 8601，不含端点。 */
  createdBefore?: string;
}

export type RetrievalMode = 'auto' | 'exact' | 'approximate';
export type VectorAggregation = 'max_chunk_cosine_v1' | 'note_level_weighted_v1';
export interface NoteSnapshotReference { handle: string; hash: string }
/** Account-bound immutable *prepared subset*, not a claim of full-library coverage. */
export interface VectorSnapshotDescriptor {
  handle: string;
  expiresAt: string;
  preparedNoteCount: number;
  range: { kind: 'prepared-subset'; eligibleNoteCount: number; unpreparedNoteCount: number };
  index: { embeddingSpaceId: string; generation: string; corpusRevision: string; coverage: IndexCoverage; provenance: IndexProvenance };
  scoring: { aggregation: 'note_level_weighted_v1'; version: string; weightSource: 'provider-per-input-usage-v1'; preprocessingVersion: string; modelFingerprint: string };
}
export interface CreateVectorSnapshotInput { scope?: VectorScope; aggregation: 'note_level_weighted_v1' }
export interface SampleVectorSnapshotInput { handle: string; excludeNoteIds?: number[] }
export interface ReadVectorSnapshotInput { handle: string; noteId: number; snapshotHash: string }
export type ReadVectorSnapshotResult =
  | { status: 'ok'; id: number; accountId: number; type: NoteType; createdAt: string; updatedAt: string; content: string; snapshotHash: string }
  | { status: 'changed'; content: string; snapshotHash: string }
  | { status: 'missing' | 'forbidden' };
export interface SampleVectorSnapshotResult {
  item: { note: VectorQueryItem['note']; snapshot: NoteSnapshotReference } | null;
  /** Complete current legal prepared-pool count BEFORE exclusions. */
  poolSize: number;
}
export interface VectorSnapshotsSdk {
  create(input: CreateVectorSnapshotInput, options?: CallOptions): Promise<VectorSnapshotDescriptor>;
  sample(input: SampleVectorSnapshotInput, options?: CallOptions): Promise<SampleVectorSnapshotResult>;
  readNote(input: ReadVectorSnapshotInput, options?: CallOptions): Promise<ReadVectorSnapshotResult>;
  release(input: { handle: string }, options?: CallOptions): Promise<void>;
}
export const VECTOR_SNAPSHOT_LIMITS = Object.freeze({
  ttlMs: 30 * 60 * 1000, maxPerAccount: 2, maxHostCount: 16, maxPreparedNotes: 50_000,
  maxSnapshotBytes: 128 * 1024 * 1024, maxAccountBytes: 256 * 1024 * 1024,
  maxHostBytes: 1024 * 1024 * 1024,
});

export interface VectorQueryInput {
  source: VectorSource;
  /** Default remains max_chunk_cosine_v1. Weighted note queries require a prepared snapshot. */
  aggregation?: VectorAggregation;
  snapshotHandle?: string;
  /** 在选取最终结果之前生效；按笔记查询自动排除源笔记。 */
  excludeNoteIds?: number[];
  /** 去重后的笔记条数，默认 10，上限见 capabilities.limits.maxResults。 */
  limit?: number;
  /** 余弦相似度阈值，取值 [-1, 1]；不传则不套用默认阈值。 */
  minScore?: number;
  scope?: VectorScope;
  /** V1 中 approximate 不可用，显式传入会被拒绝而不是静默降级。 */
  mode?: RetrievalMode;
  /**
   * 仅 source.kind === 'text' 时有效：文本查询可能产生 Embedding 费用。
   * SDK 对每次新的逻辑调用自动生成；显式重试可复用同一键。网络层不自动重试。
   * source.kind === 'note' 不产生付费调用，该字段被忽略。
   */
  idempotencyKey?: string;
  /** 调用方期望的向量空间与索引代次，不匹配时明确失败而不是混算。 */
  expectedIndex?: {
    embeddingSpaceId: string;
    generation: string;
  };
}

export interface VectorMatch {
  /** 查询来源为笔记时的片段序号。 */
  sourceChunkOrdinal?: number;
  targetChunkOrdinal: number;
  excerpt: string;
}

export interface VectorQueryItem {
  note: {
    id: number;
    type: NoteType;
    createdAt: string;
    updatedAt: string;
    excerpt: string;
  };
  /** 余弦相似度，[-1, 1]，越大越相关；不是概率。 */
  score: number;
  matches: VectorMatch[];
  /** Present for a query bound to an immutable prepared snapshot. */
  snapshot?: NoteSnapshotReference;
}

export type IndexCoverage = 'ready' | 'partial' | 'unknown';

/** 结果所用向量的来源可信度。未验证记录不参与计算，因此不会出现在这里。 */
export type IndexProvenance = 'verified' | 'legacy-attested';

export type RetrievalAlgorithm = 'exact' | 'approximate';

export type RetrievalTruncationReason =
  | 'budget'
  | 'timeout'
  | 'index-changed'
  | 'stale-candidates'
  | 'recall-limit';

export interface VectorQueryResult {
  requestId: string;
  items: VectorQueryItem[];
  scoring: {
    metric: 'cosine';
    aggregation: VectorAggregation;
    version?: string;
    higherIsBetter: true;
  };
  index: {
    embeddingSpaceId: string;
    generation: string;
    corpusRevision: string;
    coverage: IndexCoverage;
    provenance: IndexProvenance;
  };
  retrieval: {
    algorithm: RetrievalAlgorithm;
    truncated: boolean;
    /** 只有有证据的精确全扫描才能给出 'no'。 */
    remaining: 'yes' | 'no' | 'unknown';
    reason?: RetrievalTruncationReason;
  };
}

/** 当前账户视角的索引可用性。不暴露其他账户的统计。 */
export interface VectorIndexStatus {
  available: boolean;
  reason?: CapabilityUnavailableReason;
  /** 尚无可用索引时为 null，不得伪造空串或默认值。 */
  embeddingSpaceId: string | null;
  generation: string | null;
  corpusRevision: string | null;
  coverage: IndexCoverage;
  /** 无法证明来源时用 'none'，不是 legacy-attested。 */
  provenance: IndexProvenance | 'none';
}

// ---------------------------------------------------------------------------
// AI：模型目录与非流式生成
// ---------------------------------------------------------------------------

/**
 * 公共模型信息。对管理员与普通用户一致，只含下列字段。
 * 不含 apiKey、baseURL、config、供应商原始对象。
 */
export interface PublicModel {
  id: number;
  name: string;
  providerLabel: string;
  isDefault: boolean;
  capabilities: {
    text: boolean;
    streaming: boolean;
    /** 未确认时用 null，不当作 false 也不当作 true。 */
    structuredOutput: boolean | null;
  };
}

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface GenerateTextInput {
  /** 省略或 'default' 表示使用宿主默认生成模型。 */
  modelId?: number | 'default';
  system?: string;
  messages: ChatMessage[];
  /** 逐条鉴权；任一条不可访问时整体拒绝，不静默省略后继续生成。 */
  contextNoteIds?: number[];
  temperature?: number;
  maxOutputTokens?: number;
  /** 必填：非流式生成每次都是付费调用。 */
  idempotencyKey: string;
}

export type FinishReason =
  | 'stop'
  | 'length'
  | 'content-filter'
  | 'other'
  | 'unknown';

/** 供应商未报告用量时必须为 null + 'unknown'，不得填 0。 */
export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  status: 'reported' | 'estimated' | 'unknown';
}

export interface GenerateTextResult {
  requestId: string;
  text: string;
  model: { id: number; name: string };
  finishReason: FinishReason;
  usage: TokenUsage;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// 标准错误
// ---------------------------------------------------------------------------

/**
 * 错误码的运行时清单。类型由它推导，避免"联合类型和校验列表各写一份"
 * ——那种重复迟早会漂移，表现为新码被当成未知码拒绝。
 */
export const PLUGIN_SERVICE_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'INVALID_INPUT',
  'NOT_FOUND_OR_FORBIDDEN',
  'INDEX_NOT_READY',
  'SOURCE_NOT_INDEXED',
  'SOURCE_INDEX_STALE',
  'LEGACY_INDEX_UNVERIFIED',
  'EMBEDDING_SPACE_MISMATCH',
  'INDEX_CHANGED',
  'MODEL_UNAVAILABLE',
  'CAPABILITY_UNSUPPORTED',
  'QUERY_BUDGET_EXCEEDED',
  'RATE_LIMITED',
  'BUDGET_EXCEEDED',
  'IDEMPOTENCY_CONFLICT',
  'REQUEST_IN_PROGRESS',
  'RESULT_NOT_RETAINED',
  'OUTCOME_UNKNOWN',
  'TIMEOUT',
  'ABORTED',
  'PROVIDER_ERROR',
  'INTERNAL_ERROR',
] as const;

export type PluginServiceErrorCode = (typeof PLUGIN_SERVICE_ERROR_CODES)[number];

/**
 * 对插件可见的错误形状。不得携带供应商原始 body、模型 Key、
 * 请求头、内部 URL 或堆栈。
 */
export interface PluginServiceError {
  code: PluginServiceErrorCode;
  requestId: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

// ---------------------------------------------------------------------------
// SDK 接口（纯契约）
// ---------------------------------------------------------------------------
//
// 这里只描述"插件看到什么"，不描述"宿主怎么传输"。
// 实现见 app/src/store/plugin/services.ts，宿主适配层负责把下列逻辑操作
// 映射到实际的 tRPC procedure 路径。这样 SDK 不引用 AppRouter，
// 声明构建不会拉入服务端全图。

/**
 * 可取消信号的结构化最小形状。
 * 不直接用 DOM 的 AbortSignal，是为了让本文件能被 server 侧以
 * 不含 DOM lib 的 tsconfig 编译；DOM 的 AbortSignal 天然满足该结构。
 */
export interface AbortLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export interface CallOptions {
  signal?: AbortLike;
  /**
   * 协作式归因标签，用于安装说明、策略检查与费用归因。
   * 不是身份凭据，换一个标签不会获得新额度。
   */
  clientTag?: string;
}

/** Client-observed identity. Server authorization remains authoritative. No token is exposed. */
export interface PluginHostContext {
  /** Opaque local lifetime key; changes on account, endpoint, credential or authentication state changes. */
  readonly identityKey: string;
  readonly accountId: number | null;
  /** Canonical HTTP(S) service root used by the host, including Tauri's configured server. */
  readonly serviceUrl: string | null;
  readonly authentication: 'authenticated' | 'anonymous' | 'expired' | 'invalid' | 'unavailable';
  readonly expiresAt: string | null;
}

export interface PluginHostContextSdk {
  /** Synchronous local read; no network request and no provider invocation. */
  get(): PluginHostContext;
  /** Immediately emits the current value. Unsubscribe is idempotent; abort also unsubscribes. */
  subscribe(listener: (context: PluginHostContext) => void, options?: { signal?: AbortLike }): () => void;
}

export interface PluginFileUrlOptions {
  thumbnail?: boolean;
  download?: boolean;
}

export interface PluginFilesSdk {
  /** Resolve against the canonical server. Credentials are added only to its file routes. */
  url(path: string, options?: PluginFileUrlOptions): string;
}

export interface PluginServicesSdk {
  readonly apiVersion: PluginServicesApiVersion;
  /** Optional additive browser-host capabilities; absent on older or non-browser hosts. */
  readonly context?: PluginHostContextSdk;
  readonly files?: PluginFilesSdk;
  capabilities(options?: CallOptions): Promise<ServicesCapabilities>;
  vector: {
    status(options?: CallOptions): Promise<VectorIndexStatus>;
    query(input: VectorQueryInput, options?: CallOptions): Promise<VectorQueryResult>;
    snapshots: VectorSnapshotsSdk;
  };
  ai: {
    listModels(options?: CallOptions): Promise<PublicModel[]>;
    generateText(input: GenerateTextInput, options?: CallOptions): Promise<GenerateTextResult>;
  };
}
