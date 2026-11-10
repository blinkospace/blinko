import { createHash } from "node:crypto";
import { MDocument } from "@mastra/rag";
import type { NoteSnapshot, PreparedBody } from "./types";

// Changing this or the encoding input requires a distinct embedding space.
export const BODY_PREPROCESSING_VERSION =
  "markdown-mastra-rag-1.0.6-timestamps-v1";
export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function fingerprintNoteSnapshot(
  note: NoteSnapshot,
  version = BODY_PREPROCESSING_VERSION,
): string {
  return digest([
    version,
    note.content,
    note.createdAt.toISOString(),
    note.updatedAt?.toISOString() ?? "undefined",
  ]);
}
export function encodingValues(
  texts: readonly string[],
  note: NoteSnapshot,
): string[] {
  return texts.map(
    (text) =>
      text +
      "Create At: " +
      note.createdAt.toISOString() +
      " Update At: " +
      note.updatedAt?.toISOString(),
  );
}
export async function prepareBodyInput(
  note: NoteSnapshot,
): Promise<PreparedBody> {
  const chunks = await MDocument.fromMarkdown(note.content).chunk();
  const texts = chunks.map((chunk) => chunk.text);
  const values = encodingValues(texts, note);
  return {
    noteSnapshotHash: fingerprintNoteSnapshot(note),
    sourceHash: digest([BODY_PREPROCESSING_VERSION, values]),
    texts,
    values,
  };
}
