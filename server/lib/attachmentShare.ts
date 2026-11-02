import jwt from "jsonwebtoken";
import { createHmac } from "node:crypto";
import type { SharedNote } from "./fileAccessPolicy";

const fingerprint = (note: SharedNote, key: string) =>
  createHmac("sha256", key)
    .update(
      JSON.stringify([
        note.id,
        note.shareEncryptedUrl,
        note.sharePassword || "",
      ]),
    )
    .digest("hex");
const shareKey = async () => {
  const { getNextAuthSecret } = await import("./helper");
  const secret = await getNextAuthSecret();
  if (!secret) throw new Error("Attachment signing key is unavailable");
  return createHmac("sha256", secret)
    .update("blinko-file-share-v1")
    .digest("hex");
};

export async function attachmentShareToken(note: SharedNote) {
  const key = await shareKey();
  return jwt.sign({ noteId: note.id, proof: fingerprint(note, key) }, key, {
    algorithm: "HS256",
    audience: "blinko-file-share",
    expiresIn: "5m",
  });
}

export async function validAttachmentShareToken(
  token: unknown,
  note?: SharedNote | null,
) {
  if (typeof token !== "string" || token.length > 2000 || !note) return false;
  try {
    const key = await shareKey();
    const value = jwt.verify(token, key, {
      algorithms: ["HS256"],
      audience: "blinko-file-share",
    }) as jwt.JwtPayload;
    return value.noteId === note.id && value.proof === fingerprint(note, key);
  } catch {
    return false;
  }
}

export async function withAttachmentShareLinks<
  T extends {
    content: string;
    attachments: Array<{ path: string }>;
  } & SharedNote,
>(note: T): Promise<T> {
  if (!note.attachments.length) return note;
  const grant = await attachmentShareToken(note);
  const urls = new Map(
    note.attachments.map((file) => [
      file.path,
      `${file.path}?shareToken=${encodeURIComponent(grant)}`,
    ]),
  );
  return {
    ...note,
    attachments: note.attachments.map((file) => ({
      ...file,
      path: urls.get(file.path)!,
    })),
    content: note.content.replace(
      /(\/api\/(?:file|s3file)\/[^\s)"<>?#]+)(\?[^\s)"<>#]*)?/g,
      (whole, url, query) => {
        let decoded: string;
        try {
          decoded = decodeURIComponent(url);
        } catch {
          return whole;
        }
        if (!urls.has(url) && !urls.has(decoded)) return whole;
        const params = new URLSearchParams(query?.slice(1));
        params.set("shareToken", grant);
        return `${url}?${params}`;
      },
    ),
  };
}
