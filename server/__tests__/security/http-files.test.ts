import { beforeAll, afterAll, beforeEach, test, expect, mock } from "bun:test";
import express from "express";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const directory = await mkdtemp(
  path.join(os.tmpdir(), "blinko-file-security-"),
);
let record: any;
let signed: any[] = [];
let feedOrigin = "";
let checkedFilePath = "";
const previousBaseUrl = process.env.NEXT_PUBLIC_BASE_URL;
mock.module("../../../shared/lib/pathConstant", () => ({
  UPLOAD_FILE_PATH: directory,
  TEMP_PATH: path.join(directory, "temp"),
}));
mock.module("../../prisma", () => ({
  prisma: {
    attachments: {
      findFirst: async ({ where }: any) => {
        checkedFilePath = where.path;
        return record;
      },
    },
  },
}));
mock.module("../../lib/helper", () => ({
  getNextAuthSecret: async () => "TEST_ONLY_SIGNING_KEY",
  getTokenFromRequest: async (req: any) =>
    req.headers.authorization === "Bearer owner"
      ? { id: 1, role: "user" }
      : req.headers.authorization === "Bearer other"
        ? { id: 2, role: "user" }
        : null,
  generateFeed: async (_id: number, origin: string) => {
    feedOrigin = origin;
    return { rss2: () => "<rss/>", atom1: () => "<feed/>" };
  },
}));
mock.module("../../lib/files", () => ({
  FileService: {
    getS3Client: async () => ({
      s3ClientInstance: {},
      config: { s3Bucket: "test-bucket" },
    }),
    validateAndResolvePath: (input: string, base: string) => {
      const target = path.resolve(base, input);
      if (!target.startsWith(base + path.sep))
        throw new Error("path traversal");
      return target;
    },
  },
}));
mock.module("sharp", () => ({
  default: () => {
    throw new Error("Unexpected thumbnail processing");
  },
}));
mock.module("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: async (_client: any, command: any, options: any) => {
    signed.push({ input: command.input, options });
    return "https://storage.example/test-object";
  },
}));
const { default: fileRouter } = await import("../../routerExpress/file/file");
const { default: s3Router } = await import("../../routerExpress/file/s3file");
const { default: rssRouter } = await import("../../routerExpress/rss");
const {
  attachmentShareToken,
  validAttachmentShareToken,
  withAttachmentShareLinks,
} = await import("../../lib/attachmentShare");
let server: ReturnType<express.Express["listen"]>;
let origin: string;
beforeAll(async () => {
  process.env.NEXT_PUBLIC_BASE_URL = "https://trusted.example";
  await writeFile(
    path.join(directory, "upload.html"),
    "<script>unsafe</script>",
  );
  await mkdir(path.join(directory, "temp"));
  await writeFile(
    path.join(directory, "temp", "private.txt"),
    "private temporary file",
  );
  const app = express();
  app.use("/api/file", fileRouter);
  app.use("/api/s3file", s3Router);
  app.use("/api/rss", rssRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => {
  server?.close();
  await rm(directory, { recursive: true, force: true });
  if (previousBaseUrl === undefined) delete process.env.NEXT_PUBLIC_BASE_URL;
  else process.env.NEXT_PUBLIC_BASE_URL = previousBaseUrl;
});
beforeEach(() => {
  signed = [];
  record = {
    accountId: 1,
    note: {
      id: 10,
      accountId: 1,
      isShare: false,
      sharePassword: "",
      shareEncryptedUrl: "share-id",
    },
  };
});
const get = (suffix = "", identity?: string) =>
  fetch(origin + "/api/file/upload.html" + suffix, {
    headers: identity ? { Authorization: "Bearer " + identity } : {},
  });

test("actual file endpoint denies another account, anonymous callers and unregistered files", async () => {
  expect((await get("", "other")).status).toBe(403);
  expect((await get()).status).toBe(401);
  record = null;
  expect((await get("", "owner")).status).toBe(404);
});
test("owner receives HTML as download with an inert content type, sandbox and no shared cache", async () => {
  const response = await get("", "owner");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/octet-stream");
  expect(response.headers.get("content-disposition")).toStartWith(
    "attachment;",
  );
  expect(response.headers.get("content-security-policy")).toContain("sandbox");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await response.text()).toBe("<script>unsafe</script>");
});
test("public shares still work while password-protected attachments require a valid scoped grant", async () => {
  record.note.isShare = true;
  expect((await get()).status).toBe(200);
  record.note.sharePassword = "test-password";
  expect((await get()).status).toBe(401);
  const grant = await attachmentShareToken(record.note);
  expect((await get("?shareToken=" + grant)).status).toBe(200);
  record.note.sharePassword = "changed-password";
  expect((await get("?shareToken=" + grant)).status).toBe(401);
});
test("grants cannot authorize another note, revoked shares or expired shares", async () => {
  record.note.isShare = true;
  record.note.sharePassword = "test-password";
  const grant = await attachmentShareToken(record.note);
  expect(
    await validAttachmentShareToken(grant, { ...record.note, id: 20 }),
  ).toBe(false);
  expect(
    await validAttachmentShareToken("tampered." + grant, record.note),
  ).toBe(false);
  record.note.isShare = false;
  expect((await get("?shareToken=" + grant)).status).toBe(401);
  record.note.isShare = true;
  record.note.shareExpiryDate = new Date(1);
  expect((await get("?shareToken=" + grant)).status).toBe(401);
});
test("shared-note rendering grants only its own attachment URLs and preserves existing query arguments", async () => {
  const note = {
    ...record.note,
    isShare: true,
    content:
      "![image](/api/file/upload.html?thumbnail=true) ![other](/api/file/not-owned.png)",
    attachments: [{ path: "/api/file/upload.html" }],
  };
  const shared = await withAttachmentShareLinks(note);
  expect(shared.content).toContain("thumbnail=true&shareToken=");
  expect(shared.content).toContain("/api/file/not-owned.png)");
  const token = new URL(
    shared.attachments[0].path,
    "https://example.com",
  ).searchParams.get("shareToken");
  expect(await validAttachmentShareToken(token, note)).toBe(true);
});
test("ordinary login does not grant access to temporary directories", async () => {
  expect(
    (
      await fetch(origin + "/api/file/temp/private.txt", {
        headers: { Authorization: "Bearer other" },
      })
    ).status,
  ).toBe(401);
});
const s3get = (suffix = "", identity?: string) =>
  fetch(origin + "/api/s3file/upload.html" + suffix, {
    redirect: "manual",
    headers: identity ? { Authorization: "Bearer " + identity } : {},
  });
test("S3 authorization runs before issuing a presigned URL", async () => {
  expect((await s3get("", "other")).status).toBe(403);
  expect((await s3get()).status).toBe(401);
  record = null;
  expect((await s3get("", "owner")).status).toBe(404);
  expect(signed.length).toBe(0);
});
test("S3 HTML downloads use a short private presign with inert response overrides", async () => {
  const response = await s3get("", "owner");
  expect(response.status).toBe(302);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(signed[0].options.expiresIn).toBe(300);
  expect(signed[0].input.ResponseContentType).toBe("application/octet-stream");
  expect(signed[0].input.ResponseContentDisposition).toStartWith("attachment;");
  expect(signed[0].input.ResponseCacheControl).toBe("private, no-store");
});
test("S3 password shares require the same scoped grant as local files", async () => {
  record.note.isShare = true;
  record.note.sharePassword = "test-password";
  expect((await s3get()).status).toBe(401);
  const grant = await attachmentShareToken(record.note);
  expect((await s3get("?shareToken=" + grant)).status).toBe(302);
  record.note.isShare = false;
  expect((await s3get("?shareToken=" + grant)).status).toBe(401);
});
test("S3 signs exactly the object key whose attachment permission was checked", async () => {
  const response = await fetch(origin + "/api/s3file/literal%252Fname.html", {
    redirect: "manual",
    headers: { Authorization: "Bearer owner" },
  });
  expect(response.status).toBe(302);
  expect(checkedFilePath).toBe("/api/s3file/literal%2Fname.html");
  expect(signed[0].input.Key).toBe("literal%2Fname.html");
});
test.each(["rss", "atom"])(
  "%s ignores request Host and Origin when constructing feed links",
  async (type) => {
    const response = await fetch(origin + "/api/rss/1/" + type, {
      headers: { Host: "attacker.example", Origin: "https://attacker.example" },
    });
    expect(response.status).toBe(200);
    expect(feedOrigin).toBe("https://trusted.example");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  },
);
