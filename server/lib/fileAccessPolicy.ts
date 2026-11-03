import path from "node:path";

export type SharedNote = {
  id?: number;
  accountId?: number | null;
  isShare: boolean;
  internalShares?: Array<{ accountId: number }>;
  isRecycle?: boolean;
  sharePassword?: string;
  shareExpiryDate?: Date | null;
  shareEncryptedUrl?: string | null;
  shareMaxView?: number | null;
  shareViewCount?: number | null;
};
export type FileRecord = {
  accountId?: number | null;
  isShare?: boolean;
  sharePassword?: string;
  note?: SharedNote | null;
};

export function canReadFile(
  file: FileRecord | null,
  user: { id?: unknown; role?: string } | null,
  shareGrant = false,
  now = Date.now(),
) {
  if (!file) return false;
  const id = Number(user?.id);
  if (
    user &&
    (user.role === "superadmin" ||
      (id > 0 &&
        (file.accountId === id ||
          file.note?.accountId === id ||
          file.note?.internalShares?.some((share) => share.accountId === id))))
  )
    return true;
  const note = file.note;
  if (note) {
    if (
      !note.isShare ||
      note.isRecycle ||
      (note.shareExpiryDate && note.shareExpiryDate.getTime() <= now)
    )
      return false;
    if (shareGrant) return true;
    return (
      !note.sharePassword &&
      !(note.shareMaxView && (note.shareViewCount ?? 0) >= note.shareMaxView)
    );
  }
  return !!file.isShare && !file.sharePassword;
}

export function uploadedFileHeaders(
  filename: string,
  mimeType: string,
  download = false,
) {
  const active =
    !/^(image\/(jpeg|png|gif|webp|avif|bmp)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|text\/plain|application\/pdf)$/i.test(
      mimeType,
    );
  const encoded = encodeURIComponent(path.basename(filename)).replace(
    /['()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16),
  );
  return {
    "Content-Type": active ? "application/octet-stream" : mimeType,
    "Content-Disposition": `${active || download ? "attachment" : "inline"}; filename*=UTF-8''${encoded}`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
  };
}
