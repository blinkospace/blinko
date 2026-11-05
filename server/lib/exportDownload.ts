import jwt from "jsonwebtoken";
import { createHmac } from "node:crypto";

export const EXPORT_DOWNLOAD_TTL_MS = 5 * 60 * 1000;
const exportPath = /^temp\/notes_export_[a-f0-9-]{36}\.zip$/;

async function signingKey() {
  const { getNextAuthSecret } = await import("./helper");
  const secret = await getNextAuthSecret();
  if (!secret) throw new Error("Export signing key is unavailable");
  return createHmac("sha256", secret).update("blinko-export-download-v1").digest("hex");
}

// A grant alone is insufficient: the download must also authenticate as the
// account that requested this exact export. No persistent ownership rows or
// background database cleanup are needed.
export async function exportDownloadUrl(filePath: string, accountId: number) {
  if (!exportPath.test(filePath) || !Number.isSafeInteger(accountId) || accountId <= 0)
    throw new Error("Invalid export download");
  const token = jwt.sign({ path: filePath }, await signingKey(), {
    algorithm: "HS256",
    audience: "blinko-export-download",
    subject: String(accountId),
    expiresIn: EXPORT_DOWNLOAD_TTL_MS / 1000,
  });
  return `/api/file/${filePath}?exportToken=${encodeURIComponent(token)}`;
}

export async function canDownloadExport(filePath: string, accountId: unknown, token: unknown) {
  const id = Number(accountId);
  if (!exportPath.test(filePath) || !Number.isSafeInteger(id) || id <= 0 ||
      typeof token !== "string" || token.length > 2000) return false;
  try {
    const grant = jwt.verify(token, await signingKey(), {
      algorithms: ["HS256"], audience: "blinko-export-download", subject: String(id),
    }) as jwt.JwtPayload;
    return grant.path === filePath;
  } catch {
    return false;
  }
}
