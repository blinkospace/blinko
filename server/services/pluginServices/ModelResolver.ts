import type { EmbeddingModelV1 } from "@ai-sdk/provider";
import { embed, embedMany, generateText } from "ai";
import type { LanguageModelV1 } from "@ai-sdk/provider";
import type { ModelCatalog, TextGeneratorFactory } from "./AiGenerationService";
import type { AuthorizedModelRecord } from "./aiSchemas";
import { BODY_PREPROCESSING_VERSION, digest } from "./BodyInput";
import { ServiceError } from "./errors";
import type { EmbeddingSpace } from "./types";
import { TOKEN_WEIGHT_VERSION, type BodyEncodingResult } from './NoteAggregation';

export interface EmbeddingModelRecord {
  id: number;
  modelKey: string;
  config?: unknown;
  provider: {
    id: number;
    provider: string;
    apiKey?: string | null;
    baseURL?: string | null;
    config?: unknown;
  };
}
export function createTextModelCatalog(deps: {
  listMetadata(accountId: number): Promise<AuthorizedModelRecord[]>;
  readDefaultModelId(accountId: number): Promise<number | null>;
}): ModelCatalog {
  return {
    listTextModels: deps.listMetadata,
    defaultTextModelId: deps.readDefaultModelId,
    async findTextModel(accountId, modelRef) {
      const id = modelRef === "default" ? await deps.readDefaultModelId(accountId) : modelRef;
      if (!id) return null;
      const model = (await deps.listMetadata(accountId)).find(
        (record) => record.id === id && record.capabilities?.inference === true,
      );
      return model ? { id: model.id, name: model.title } : null;
    },
  };
}

export function createTextGeneratorFactory(deps: {
  createLanguageModel(accountId: number, modelId: number): Promise<LanguageModelV1 | null>;
}): TextGeneratorFactory {
  return {
    async create(accountId, modelId) {
      const model = await deps.createLanguageModel(accountId, modelId);
      if (!model) throw new ServiceError("MODEL_UNAVAILABLE");
      return {
        async generate(request) {
          const result = await generateText({
            model,
            system: request.system,
            messages: request.messages,
            temperature: request.temperature,
            maxTokens: request.maxOutputTokens,
            abortSignal: request.signal,
            maxRetries: 0,
          });
          const inputTokens =
            Number.isSafeInteger(result.usage?.promptTokens) && result.usage.promptTokens >= 0
              ? result.usage.promptTokens
              : null;
          const outputTokens =
            Number.isSafeInteger(result.usage?.completionTokens) &&
            result.usage.completionTokens >= 0
              ? result.usage.completionTokens
              : null;
          return {
            text: result.text,
            finishReason: ["stop", "length", "content-filter", "other", "unknown"].includes(
              result.finishReason,
            )
              ? (result.finishReason as "stop" | "length" | "content-filter" | "other" | "unknown")
              : "other",
            usage: {
              inputTokens,
              outputTokens,
              status: inputTokens === null || outputTokens === null ? "unknown" : "reported",
            },
          };
        },
      };
    },
  };
}

export interface ModelResolverDeps {
  readEmbeddingModel(): Promise<EmbeddingModelRecord | null>;
  createEmbeddingModel(model: EmbeddingModelRecord): Promise<EmbeddingModelV1<string> | null>;
}
export interface ResolvedEmbedding {
  modelId: number;
  space: EmbeddingSpace;
  embedQueryText(
    text: string,
    signal?: AbortSignal,
    beforeDispatch?: () => Promise<void>,
  ): Promise<{ vector: number[]; tokens: number | null }>;
  embedBody(values: string[], signal?: AbortSignal): Promise<number[][]>;
  /** Explicit writer/rebuild only: individual calls give verifiable per-input usage.
   * Never used by a query, discovery, or an automatic legacy backfill. */
  embedBodyMeasured?(values: string[], signal?: AbortSignal): Promise<BodyEncodingResult>;
}

export function embeddingDimensions(modelKey: string, config?: unknown): number {
  const configured = (config as { embeddingDimensions?: unknown } | null)?.embeddingDimensions;
  if (configured !== undefined && configured !== null && configured !== 0) {
    if (
      typeof configured !== "number" ||
      !Number.isSafeInteger(configured) ||
      configured <= 0 ||
      configured > 65536
    )
      throw new ServiceError("MODEL_UNAVAILABLE");
    return configured;
  }
  const key = modelKey.toLowerCase();
  const known: Array<[string, number]> = [
    ["text-embedding-3-small", 1536],
    ["text-embedding-3-large", 3072],
    ["voyage-3-lite", 512],
    ["cohere/embed-english-v3", 1024],
    ["bge-m3", 1024],
    ["bge-large", 1024],
    ["voyage", 1024],
    ["cohere", 4096],
    ["bge", 768],
    ["bert", 768],
    ["bce-embedding-base", 768],
    ["all-minilm", 384],
    ["mxbai-embed-large", 1024],
    ["nomic-embed-text", 768],
  ];
  const dimension = known.find(([name]) => key.includes(name))?.[1];
  if (!dimension) throw new ServiceError("MODEL_UNAVAILABLE");
  return dimension;
}

/** Resolves embedding independently; no LLM, audio, vector store or Agent construction. */
export function createModelResolver(deps: ModelResolverDeps) {
  return {
    async resolveEmbedding(): Promise<ResolvedEmbedding> {
      const record = await deps.readEmbeddingModel();
      if (!record?.provider || !record.modelKey) throw new ServiceError("MODEL_UNAVAILABLE");
      const dimensions = embeddingDimensions(record.modelKey, record.config);
      const modelFingerprint = digest([
        "provider-v1",
        record.id,
        record.provider.id,
        record.provider.provider,
        record.provider.baseURL ?? null,
        record.modelKey,
        (record.provider.config as { apiVersion?: unknown } | null)?.apiVersion ?? null,
        dimensions,
      ]);
      const space: EmbeddingSpace = {
        dimensions,
        modelFingerprint,
        preprocessingVersion: BODY_PREPROCESSING_VERSION,
        embeddingSpaceId: digest([modelFingerprint, BODY_PREPROCESSING_VERSION, dimensions]),
      };
      // Creation is lazy: even compatibility/capability checks never initialize a provider.
      let resolved: Promise<EmbeddingModelV1<string>> | undefined;
      const get = () =>
        (resolved ??= (async () => {
          const model = await deps.createEmbeddingModel(record);
          if (!model) throw new ServiceError("MODEL_UNAVAILABLE");
          return model;
        })());
      return {
        modelId: record.id,
        space,
        async embedQueryText(text, signal, beforeDispatch) {
          const model = await get();
          if (signal?.aborted) throw new ServiceError("ABORTED");
          await beforeDispatch?.();
          const result = await embed({
            value: text,
            model,
            abortSignal: signal,
            maxRetries: 0,
          });
          return {
            vector: result.embedding,
            tokens: result.usage?.tokens ?? null,
          };
        },
        async embedBodyMeasured(values, signal) {
          const vectors: number[][] = [];
          const counts: number[] = [];
          let reported = true;
          for (const value of values) {
            if (signal?.aborted) throw new ServiceError('ABORTED');
            const result = await embed({ model: await get(), value, abortSignal: signal, maxRetries: 0 });
            vectors.push(result.embedding);
            const tokens = result.usage?.tokens;
            if (!Number.isSafeInteger(tokens) || tokens <= 0 || tokens > 2147483647) reported = false;
            counts.push(tokens);
          }
          return { vectors, ...(reported && values.length ? { tokenWeights: {
            version: TOKEN_WEIGHT_VERSION, modelFingerprint: space.modelFingerprint,
            sourceHash: digest([space.preprocessingVersion, values]), counts,
          } } : {}) };
        },
        async embedBody(values, signal) {
          const result = await embedMany({
            values,
            model: await get(),
            abortSignal: signal,
            maxRetries: 0,
          });
          return result.embeddings;
        },
      };
    },
  };
}
