import { expect, test } from "bun:test";
import type { EmbeddingModelV1 } from "@ai-sdk/provider";
import {
  weightedMeanVector,
  validateWeightWitness,
  TOKEN_WEIGHT_VERSION,
} from "../../services/pluginServices/NoteAggregation";
import { createModelResolver } from "../../services/pluginServices/ModelResolver";
import { digest } from "../../services/pluginServices/BodyInput";
const dot = (a: number[], b: number[]) =>
  a.reduce((n, x, i) => n + x * b[i], 0);

test("independent two-dimensional counterexample reverses max-chunk and weighted-note rankings", () => {
  const source = weightedMeanVector([
    { vector: [1, 0], tokens: 1 },
    { vector: [0, 1], tokens: 1 },
  ]);
  const a = [1, 0],
    b = [Math.SQRT1_2, Math.SQRT1_2];
  const maxA = Math.max(dot([1, 0], a), dot([0, 1], a));
  const maxB = Math.max(dot([1, 0], b), dot([0, 1], b));
  expect(maxA).toBeGreaterThan(maxB);
  expect(dot(source, b)).toBeGreaterThan(dot(source, a));
  expect(dot(source, b)).toBeCloseTo(1, 12);
  expect(dot(source, a)).toBeCloseTo(Math.SQRT1_2, 12);
});
test("normalize chunks before applying unequal token weights; do not weight vector magnitudes", () => {
  const result = weightedMeanVector([
    { vector: [1000, 0], tokens: 1 },
    { vector: [0, 7], tokens: 3 },
  ]);
  expect(result[0]).toBeCloseTo(1 / Math.sqrt(10), 12);
  expect(result[1]).toBeCloseTo(3 / Math.sqrt(10), 12);
});
test("invalid or missing weights, zero/cancelling vectors and mixed dimensions cannot fabricate a score", () => {
  for (const tokens of [0, -1, NaN, Infinity, 1.5])
    expect(() => weightedMeanVector([{ vector: [1, 0], tokens }])).toThrow();
  for (const chunks of [
    [],
    [{ vector: [0, 0], tokens: 1 }],
    [
      { vector: [1, 0], tokens: 1 },
      { vector: [-1, 0], tokens: 1 },
    ],
    [
      { vector: [1], tokens: 1 },
      { vector: [0, 1], tokens: 1 },
    ],
  ])
    expect(() => weightedMeanVector(chunks)).toThrow();
});
test("weight evidence is bound to exact encoded-input fingerprint and model, never a batch total", () => {
  const body = {
    sourceHash: "source",
    values: ["one", "two"],
    texts: ["one", "two"],
    noteSnapshotHash: "note",
  };
  const witness = {
    version: TOKEN_WEIGHT_VERSION,
    sourceHash: "source",
    modelFingerprint: "model",
    counts: [2, 5],
  };
  expect(() =>
    validateWeightWitness(witness, body, { modelFingerprint: "model" }),
  ).not.toThrow();
  for (const changed of [
    { ...witness, counts: [7] },
    { ...witness, sourceHash: "other" },
    { ...witness, modelFingerprint: "other" },
  ])
    expect(() =>
      validateWeightWitness(changed, body, { modelFingerprint: "model" }),
    ).toThrow();
});
function measuredResolver(reportUsage: boolean) {
  const calls: string[][] = [];
  let constructions = 0;
  const model: EmbeddingModelV1<string> = {
    specificationVersion: "v1",
    provider: "synthetic",
    modelId: "synthetic-usage",
    maxEmbeddingsPerCall: 100,
    supportsParallelCalls: true,
    async doEmbed(input) {
      calls.push(input.values);
      return {
        embeddings: input.values.map(() => [1, 0]),
        ...(reportUsage ? { usage: { tokens: input.values[0].length } } : {}),
      };
    },
  };
  const resolver = createModelResolver({
    readEmbeddingModel: async () => ({
      id: 1,
      modelKey: "synthetic",
      config: { embeddingDimensions: 2 },
      provider: { id: 2, provider: "synthetic" },
    }),
    createEmbeddingModel: async () => {
      constructions++;
      return model;
    },
  });
  return { calls, resolver, constructions: () => constructions };
}
test("explicit measured writer uses individual actual inputs and records their reported usage, without network", async () => {
  const fake = measuredResolver(true);
  const resolved = await fake.resolver.resolveEmbedding();
  expect(fake.constructions()).toBe(0);
  const result = await resolved.embedBodyMeasured!(["a", "long"]);
  expect(fake.calls).toEqual([["a"], ["long"]]);
  expect(result.tokenWeights?.counts).toEqual([1, 4]);
  expect(result.tokenWeights?.sourceHash).toBe(
    digest([resolved.space.preprocessingVersion, ["a", "long"]]),
  );
  expect(result.tokenWeights?.modelFingerprint).toBe(
    resolved.space.modelFingerprint,
  );
  expect(fake.constructions()).toBe(1);
});
test("unknown provider usage stays unproven and the ordinary encoder keeps its batching behavior", async () => {
  const unknown = measuredResolver(false);
  const resolved = await unknown.resolver.resolveEmbedding();
  expect(
    (await resolved.embedBodyMeasured!(["a", "b"])).tokenWeights,
  ).toBeUndefined();
  const ordinary = measuredResolver(true);
  await (await ordinary.resolver.resolveEmbedding()).embedBody(["a", "b"]);
  expect(ordinary.calls).toEqual([["a", "b"]]);
});
