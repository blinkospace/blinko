import { digest } from "./BodyInput";
import { ServiceError } from "./errors";
import type { BodyRevision, IndexGeneration, PreparedBody } from "./types";

export const NOTE_AGGREGATION = "note_level_weighted_v1" as const;
/** Counts are reported for each *individual encoded input*, including the host's
 * versioned preprocessing. A batch total or a guessed/local foreign tokenizer
 * is never accepted as evidence of those counts. This is not a price estimate. */
export const TOKEN_WEIGHT_VERSION = "provider-per-input-usage-v1" as const;
export interface TokenWeightWitness {
  version: typeof TOKEN_WEIGHT_VERSION;
  modelFingerprint: string;
  sourceHash: string;
  counts: number[];
}
export interface BodyEncodingResult {
  vectors: number[][];
  tokenWeights?: TokenWeightWitness;
}
export type BodyEncoderOutput = number[][] | BodyEncodingResult;
export interface StoredTokenWeight {
  version: typeof TOKEN_WEIGHT_VERSION;
  modelFingerprint: string;
  sourceHash: string;
  tokens: number;
  countsHash: string;
}
const validCount = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= 2147483647;
export function validateWeightWitness(
  witness: TokenWeightWitness,
  body: PreparedBody,
  generation: Pick<IndexGeneration, "modelFingerprint">,
): void {
  if (
    witness.version !== TOKEN_WEIGHT_VERSION ||
    witness.modelFingerprint !== generation.modelFingerprint ||
    witness.sourceHash !== body.sourceHash ||
    witness.counts.length !== body.values.length ||
    !witness.counts.every(validCount)
  )
    throw new ServiceError("INVALID_INPUT");
}
export function storedTokenWeight(
  witness: TokenWeightWitness,
  ordinal: number,
): StoredTokenWeight {
  return {
    version: witness.version,
    modelFingerprint: witness.modelFingerprint,
    sourceHash: witness.sourceHash,
    tokens: witness.counts[ordinal],
    countsHash: digest(witness.counts),
  };
}
export function decodeTokenWeight(
  value: unknown,
): StoredTokenWeight | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Partial<StoredTokenWeight>;
  if (
    v.version !== TOKEN_WEIGHT_VERSION ||
    typeof v.modelFingerprint !== "string" ||
    !v.modelFingerprint ||
    typeof v.sourceHash !== "string" ||
    !v.sourceHash ||
    !validCount(v.tokens) ||
    typeof v.countsHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(v.countsHash)
  )
    return undefined;
  return v as StoredTokenWeight;
}
function normalized(vector: readonly number[]): number[] {
  if (!vector.length || !vector.every(Number.isFinite))
    throw new ServiceError("SOURCE_NOT_INDEXED");
  // Scaling avoids overflow/underflow for finite, non-unit stored vectors.
  let scale = 0;
  for (const x of vector) scale = Math.max(scale, Math.abs(x));
  if (!scale) throw new ServiceError("SOURCE_NOT_INDEXED");
  let sum = 0;
  for (const x of vector) sum += (x / scale) ** 2;
  const divisor = Math.sqrt(sum);
  return vector.map((x) => x / scale / divisor);
}
/** Normalize every chunk, take the token-weighted mean, then normalize the note.
 * A cancelling mean has no cosine direction and is unavailable, never a zero score. */
export function weightedMeanVector(
  chunks: readonly { vector: readonly number[]; tokens: number }[],
): number[] {
  if (!chunks.length || !chunks.every((c) => validCount(c.tokens)))
    throw new ServiceError("SOURCE_NOT_INDEXED");
  const dimensions = chunks[0].vector.length;
  if (!dimensions || !chunks.every((c) => c.vector.length === dimensions))
    throw new ServiceError("SOURCE_NOT_INDEXED");
  const total = chunks.reduce((n, c) => n + c.tokens, 0);
  if (!Number.isSafeInteger(total))
    throw new ServiceError("SOURCE_NOT_INDEXED");
  const mean = Array<number>(dimensions).fill(0);
  for (const chunk of chunks) {
    const unit = normalized(chunk.vector);
    for (let d = 0; d < dimensions; d++)
      mean[d] += unit[d] * (chunk.tokens / total);
  }
  return normalized(mean);
}
export function encodeVectorF32(vector: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(vector.length * 4);
  const view = new DataView(bytes.buffer);
  vector.forEach((value, i) => view.setFloat32(i * 4, value, true));
  return bytes;
}
export function aggregateVerifiedRevision(
  revision: BodyRevision,
  generation: IndexGeneration,
): {
  vector: number[];
  proof: {
    version: typeof TOKEN_WEIGHT_VERSION;
    tokens: number;
    countsHash: string;
    sourceHash: string;
    modelFingerprint: string;
  };
} {
  const weights = revision.chunks.map((c) => c.tokenWeight);
  if (
    !weights.length ||
    weights.some(
      (w) =>
        !w ||
        w.version !== TOKEN_WEIGHT_VERSION ||
        w.sourceHash !== revision.sourceHash ||
        w.modelFingerprint !== generation.modelFingerprint,
    )
  )
    throw new ServiceError("SOURCE_NOT_INDEXED");
  const proven = weights as StoredTokenWeight[];
  const counts = proven.map((w) => w.tokens);
  const countsHash = digest(counts);
  if (
    !counts.every(validCount) ||
    proven.some((w) => w.countsHash !== countsHash)
  )
    throw new ServiceError("SOURCE_NOT_INDEXED");
  return {
    vector: weightedMeanVector(
      revision.chunks.map((c, i) => ({ vector: c.vector, tokens: counts[i] })),
    ),
    proof: {
      version: TOKEN_WEIGHT_VERSION,
      tokens: counts.reduce((a, b) => a + b, 0),
      countsHash,
      sourceHash: revision.sourceHash,
      modelFingerprint: generation.modelFingerprint,
    },
  };
}
