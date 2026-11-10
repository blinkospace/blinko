// Host-only index types. Never export these through the plugin type package.
export interface NoteSnapshot {
  id: number;
  accountId: number;
  content: string;
  createdAt: Date;
  updatedAt?: Date;
  isRecycle?: boolean;
}
export interface EmbeddingSpace {
  embeddingSpaceId: string;
  dimensions: number;
  modelFingerprint: string;
  preprocessingVersion: string;
}
export interface IndexGeneration extends EmbeddingSpace {
  generation: string;
  tableName: string;
  state: "building" | "ready";
}
export interface PreparedBody {
  noteSnapshotHash: string;
  sourceHash: string;
  texts: string[];
  values: string[];
}
export interface RevisionLease {
  revisionId: string;
  noteInstance?: string;
  accountId: number;
  noteId: number;
  generation: string;
  noteSnapshotHash: string;
  sourceHash: string;
  chunkCount: number;
  epoch: number;
  oldRevisionIds: string[];
}
export interface BodyRevision {
  accountId: number;
  noteId: number;
  revisionId: string;
  noteSnapshotHash: string;
  sourceHash: string;
  embeddingSpaceId: string;
  generation: string;
  chunkCount: number;
  provenance: "verified" | "legacy-attested";
  chunks: Array<{ ordinal: number; text: string; vector: number[]; tokenWeight?: import('./NoteAggregation').StoredTokenWeight }>;
}
export interface NoteSource {
  readNote(noteId: number): Promise<NoteSnapshot | null>;
  /** Durable PG note instance; does not certify body eligibility or call a provider. */
  readInstance?(noteId: number): Promise<string | null>;
}
