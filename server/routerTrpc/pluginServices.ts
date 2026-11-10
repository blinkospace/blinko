import { z } from "zod";
import { Prisma } from "@prisma/client";
import { router } from "../middleware";
import { prisma } from "../prisma";
import {
  hostIndex,
  hostModelResolver,
} from "../services/pluginServices/HostIndex";
import { createVectorQueryService } from "../services/pluginServices/VectorQueryService";
import {
  createQueryNoteSource,
  createQueryRateGate,
} from "../services/pluginServices/VectorQueryHost";
import {
  vectorQueryInputSchema,
  createVectorSnapshotSchema,
  sampleVectorSnapshotSchema,
  readVectorSnapshotSchema,
  snapshotHandleSchema,
} from "../services/pluginServices/vectorSchemas";
import { createVectorSnapshotService } from "../services/pluginServices/VectorSnapshotService";
import { NoteQualificationRegistry } from '../services/pluginServices/NoteQualification';
import { REVISION_CERTIFICATE_VERSION } from '../services/pluginServices/RevisionReferences';
import {
  createAccountRateGate,
  createCallPolicy,
} from "../services/pluginServices/CallPolicy";
import {
  aiRouter,
  describeAiFeatures,
} from "../services/pluginServices/aiRouter";
import {
  createPolicyStore,
  MAX_DAILY_TOKEN_BUDGET,
} from "../services/pluginServices/PolicyStore";
import { serviceProcedure } from "../services/pluginServices/procedure";
import { describeServices } from "../services/pluginServices/capabilities";
import { ServiceError } from "../services/pluginServices/errors";
import type { VectorIndexStatus } from "../../shared/lib/pluginServices/v1";
import packageInfo from "../../package.json";

export const hostPolicyStore = createPolicyStore({
  read: () => prisma.pluginServicePolicy.findUnique({ where: { id: 1 } }),
});
export const hostVectorQueryService = createVectorQueryService({
  notes: createQueryNoteSource(prisma),
  policyStore: hostPolicyStore,
  rateGate: createQueryRateGate(prisma),
  callPolicy: createCallPolicy({ prisma }),
  resolveEmbedding: () => hostModelResolver.resolveEmbedding(),
  withReader: hostIndex.withReader,
});
const hostQualifications = new NoteQualificationRegistry(prisma);
export const hostVectorSnapshotService = createVectorSnapshotService({
  notes: createQueryNoteSource(prisma),
  qualifications: hostQualifications,
  policyStore: hostPolicyStore,
  rateGate: createQueryRateGate(prisma),
  withStore: hostIndex.withSnapshotStore,
  async classifyMissing(accountId, noteId) {
    const row = await prisma.notes.findUnique({
      where: { id: noteId },
      select: { accountId: true, isRecycle: true },
    });
    return !row || row.isRecycle || row.accountId === accountId
      ? "missing"
      : "forbidden";
  },
});
async function noteSnapshotsReady(accountId: number): Promise<boolean> {
  try { await hostQualifications.stamp(accountId); }
  catch (error) { if (error instanceof ServiceError && error.code === 'INDEX_NOT_READY') return false; throw error; }
  return hostIndex.withReader(async (repository) => {
    if (!repository) return false;
    const tables = await repository.client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('blinko_ps_note_vectors','blinko_ps_snapshots','blinko_ps_snapshot_refs','blinko_ps_vector_certificates')",
    );
    if (tables.rows.length !== 4) return false;
    const active = await repository.readActiveGeneration();
    if (!active) return false;
    const rows = await repository.client.execute({
      sql: `SELECT 1 FROM blinko_ps_note_vectors n JOIN blinko_ps_vector_certificates c ON c.revision_id=n.revision_id
      JOIN blinko_ps_revisions r ON r.revision_id=n.revision_id JOIN blinko_ps_heads h ON h.account_id=r.account_id AND h.note_id=r.note_id
      WHERE n.account_id=? AND r.account_id=n.account_id AND r.note_id=n.note_id AND n.generation=? AND r.generation=n.generation AND r.snapshot_hash=n.snapshot_hash AND r.state='published' AND h.tombstone=0
      AND c.certificate_version=? LIMIT 1`,
      args: [accountId, active.generation, REVISION_CERTIFICATE_VERSION],
    });
    return rows.rows.length > 0;
  });
}
const features = new Set([
  "vector.status",
  "vector.queryByNote",
  "vector.queryByText",
  "vector.exact",
  "vector.approximate",
  "vector.noteLevelAggregation",
  "vector.snapshots",
  "ai.listModels",
  "ai.generateText",
]);
const policyInput = z.strictObject({
  limits: z
    .strictObject({
      maxResults: z.number().int().positive().optional(),
      maxExcludeIds: z.number().int().positive().optional(),
      maxInputBytes: z.number().int().positive().optional(),
      maxOutputTokens: z.number().int().positive().optional(),
      maxConcurrentGeneration: z.number().int().positive().optional(),
    })
    .optional(),
  features: z
    .record(
      z.string().refine((key) => features.has(key)),
      z.strictObject({
        enabled: z.boolean(),
        reason: z.string().max(200).optional(),
      }),
    )
    .optional(),
  modelAllowlist: z
    .array(z.number().int().positive())
    .max(1000)
    .nullable()
    .optional(),
  maxRequestsPerMinute: z.number().int().min(1).max(240).optional(),
  readNoteRequestsPerMinute: z.number().int().min(1).max(20).nullable().optional(),
  dailyTokenBudget: z
    .number()
    .int()
    .min(1)
    .max(MAX_DAILY_TOKEN_BUDGET)
    .optional(),
});
async function indexStatus(accountId: number): Promise<VectorIndexStatus> {
  return hostIndex.withReader(async (repository) =>
    repository
      ? repository.readStatus(accountId)
      : {
          available: false,
          reason: "index-not-ready",
          embeddingSpaceId: null,
          generation: null,
          corpusRevision: null,
          coverage: "unknown",
          provenance: "none",
        },
  );
}

// Discovery checks metadata and policy only; it never constructs a provider.
export const pluginServicesRouter = router({
  capabilities: serviceProcedure("capabilities").query(async ({ ctx }) => {
    const [policy, index] = await Promise.all([
      hostPolicyStore.load(),
      indexStatus(Number(ctx.id)),
    ]);
    const ai = await describeAiFeatures(Number(ctx.id));
    let vectorText: {
      available: boolean;
      reason?: "not-configured" | "index-not-ready";
    } = {
      available: false,
      reason: "not-configured",
    };
    if (
      policy.ok &&
      index.available &&
      hostPolicyStore.capability(policy, "vector.queryByText").available
    ) {
      try {
        const model = await hostModelResolver.resolveEmbedding();
        vectorText =
          model.space.embeddingSpaceId === index.embeddingSpaceId &&
          hostPolicyStore.isModelAllowed(policy, model.modelId)
            ? { available: true }
            : { available: false, reason: "not-configured" };
      } catch (error) {
        if (
          !(error instanceof ServiceError && error.code === "MODEL_UNAVAILABLE")
        )
          throw error;
      }
    }
    return describeServices({
      vectorQueryReady: true,
      noteSnapshotsReady:
        index.available && (await noteSnapshotsReady(Number(ctx.id))),
      vectorText,
      ai,
      hostVersion: packageInfo.version,
      policy,
      policyStore: hostPolicyStore,
      permissions: ctx.permissions,
      index,
    });
  }),
  ai: aiRouter,
  vector: router({
    query: serviceProcedure("vector.query")
      .input(vectorQueryInputSchema)
      .mutation(({ ctx, input }) =>
        input.aggregation === "note_level_weighted_v1"
          ? hostVectorSnapshotService.query(Number(ctx.id), input)
          : hostVectorQueryService.query(Number(ctx.id), input),
      ),
    snapshots: router({
      create: serviceProcedure("vector.snapshots.create")
        .input(createVectorSnapshotSchema)
        .mutation(({ ctx, input }) =>
          hostVectorSnapshotService.create(Number(ctx.id), input),
        ),
      sample: serviceProcedure("vector.snapshots.sample")
        .input(sampleVectorSnapshotSchema)
        .mutation(({ ctx, input }) =>
          hostVectorSnapshotService.sample(Number(ctx.id), input),
        ),
      readNote: serviceProcedure("vector.snapshots.readNote")
        .input(readVectorSnapshotSchema)
        .mutation(({ ctx, input }) =>
          hostVectorSnapshotService.readNote(Number(ctx.id), input),
        ),
      release: serviceProcedure("vector.snapshots.release")
        .input(snapshotHandleSchema)
        .mutation(({ ctx, input }) =>
          hostVectorSnapshotService.release(Number(ctx.id), input),
        ),
    }),
    status: serviceProcedure("vector.status").query(async ({ ctx }) => {
      const policy = await hostPolicyStore.load();
      const capability = hostPolicyStore.capability(policy, "vector.status");
      if (!capability.available)
        return {
          available: false,
          reason: capability.reason,
          embeddingSpaceId: null,
          generation: null,
          corpusRevision: null,
          coverage: "unknown",
          provenance: "none",
        } satisfies VectorIndexStatus;
      return indexStatus(Number(ctx.id));
    }),
  }),
  admin: router({
    getPolicy: serviceProcedure("admin.getPolicy").query(() =>
      hostPolicyStore.load(),
    ),
    setPolicy: serviceProcedure("admin.setPolicy")
      .input(policyInput)
      .mutation(async ({ input, ctx }) => {
        const policy = await createPolicyStore({
          read: async () => input,
        }).load();
        if (!policy.ok) throw new ServiceError("INVALID_INPUT");
        const data = {
          limits: { ...policy.limits },
          features: input.features ?? {},
          modelAllowlist: input.modelAllowlist ?? Prisma.DbNull,
          dailyTokenBudget: policy.dailyTokenBudget,
          maxRequestsPerMinute: policy.maxRequestsPerMinute,
          // Omission by older clients preserves this new setting. Only an
          // explicit integer enables splitting; explicit null disables it.
          ...(input.readNoteRequestsPerMinute === undefined ? {} : {
            readNoteRequestsPerMinute: policy.readNoteRequestsPerMinute,
          }),
          updatedBy: Number(ctx.id),
        };
        await prisma.pluginServicePolicy.upsert({
          where: { id: 1 },
          create: { id: 1, ...data },
          update: data,
        });
        return hostPolicyStore.load();
      }),
  }),
});
