import { z } from "zod";
import { PLUGIN_SERVICES_POLICY_LIMITS } from "../../../shared/lib/pluginServices/v1";

const id = z.number().int().positive().max(2147483647);
const ids = z.array(id).max(PLUGIN_SERVICES_POLICY_LIMITS.maxExcludeIds);
const timestamp = z.string().datetime({ offset: true });
export const vectorQueryInputSchema = z
  .strictObject({
    source: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("note"), noteId: id }),
      z.strictObject({
        kind: z.literal("text"),
        text: z
          .string()
          .min(1)
          .max(262144)
          .refine((s) => s.trim().length > 0),
      }),
    ]),
    aggregation: z.enum(['max_chunk_cosine_v1', 'note_level_weighted_v1']).optional(),
    snapshotHandle: z.string().uuid().optional(),
    excludeNoteIds: ids.optional(),
    limit: z.number().int().min(1).max(PLUGIN_SERVICES_POLICY_LIMITS.maxResults).optional(),
    minScore: z.number().finite().min(-1).max(1).optional(),
    scope: z
      .strictObject({
        types: z
          .array(z.union([z.literal(0), z.literal(1), z.literal(2)]))
          .min(1)
          .max(3)
          .optional(),
        includeArchived: z.boolean().optional(),
        tagIds: ids.optional(),
        tagMatch: z.enum(["any", "all"]).optional(),
        createdFrom: timestamp.optional(),
        createdBefore: timestamp.optional(),
      })
      .refine(
        (s) =>
          !s.createdFrom ||
          !s.createdBefore ||
          Date.parse(s.createdFrom) < Date.parse(s.createdBefore),
      )
      .optional(),
    mode: z.enum(["auto", "exact", "approximate"]).optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
    expectedIndex: z
      .strictObject({
        embeddingSpaceId: z.string().min(1).max(200),
        generation: z.string().min(1).max(200),
      })
      .optional(),
  })
  .superRefine((input, ctx) => {
    const weighted = input.aggregation === 'note_level_weighted_v1';
    if (weighted !== Boolean(input.snapshotHandle) || (weighted && input.source.kind !== 'note'))
      ctx.addIssue({ code: 'custom', message: 'Weighted note queries require a snapshot' });
    if (
      new TextEncoder().encode(JSON.stringify(input)).length >
      PLUGIN_SERVICES_POLICY_LIMITS.maxInputBytes
    )
      ctx.addIssue({ code: "custom", message: "Input exceeds byte budget" });
    if (input.source.kind === "text" && !input.idempotencyKey)
      ctx.addIssue({
        code: "custom",
        path: ["idempotencyKey"],
        message: "Text queries require an idempotency key",
      });
  });

export const createVectorSnapshotSchema = z.strictObject({
  scope: vectorQueryInputSchema.shape.scope,
  aggregation: z.literal('note_level_weighted_v1'),
});
export const snapshotHandleSchema = z.strictObject({ handle: z.string().uuid() });
export const sampleVectorSnapshotSchema = snapshotHandleSchema.extend({ excludeNoteIds: ids.optional() });
export const readVectorSnapshotSchema = snapshotHandleSchema.extend({ noteId: id, snapshotHash: z.string().regex(/^[a-f0-9]{64}$/) });

// Server computation limits; clients cannot raise them. Benchmarks and limitations
// are documented separately from the public result/input limits.
export const VECTOR_QUERY_BUDGET = Object.freeze({
  maxSourceChunks: 64,
  maxTargetChunks: 50_000,
  maxNotes: 50_000,
  maxVectorValues: 32 * 1024 * 1024,
  maxDimensionOps: 100_000_000,
  timeoutMs: 2_000,
  hardTimeoutMs: 4_000,
  pageSize: 128,
  maxNoteBytes: 4 * 1024 * 1024,
  maxMetadataBytesPerPage: 8 * 1024 * 1024,
});
export type VectorQueryBudget = Record<keyof typeof VECTOR_QUERY_BUDGET, number>;
