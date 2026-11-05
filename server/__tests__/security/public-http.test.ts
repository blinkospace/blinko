import { beforeEach, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

let responses: Array<{ status: number; location?: string; body?: string }>;
let requests: Array<{ url: string; options: any }>;
let answers = [{ address: "1.1.1.1", family: 4 }];
let lookups = 0;
let stalledDns = false;
mock.module("node:dns/promises", () => ({
  lookup: async () => {
    lookups++;
    return stalledDns ? new Promise(() => {}) : answers;
  },
}));
const get = (url: URL, options: any, callback: any) => {
  requests.push({ url: url.href, options });
  const request: any = new EventEmitter();
  request.destroy = (error?: Error) => {
    if (error) request.emit("error", error);
    request.emit("close");
  };
  const next = responses.shift()!;
  queueMicrotask(() => {
    const stream: any = Readable.from([Buffer.from(next.body || "ok")]);
    stream.statusCode = next.status;
    stream.headers = next.location
      ? { location: next.location }
      : { "content-type": "text/html" };
    callback(stream);
    stream.on("end", () => request.emit("close"));
  });
  return request;
};
mock.module("node:http", () => ({ default: { get } }));
mock.module("node:https", () => ({ default: { get } }));
const { fetchPublicUrl } = await import("../../lib/publicHttp");
beforeEach(() => {
  responses = [{ status: 200, body: "public content" }];
  requests = [];
  answers = [{ address: "1.1.1.1", family: 4 }];
  lookups = 0;
  stalledDns = false;
});

test("transport pins the validated address rather than resolving again on connect", async () => {
  const response = await fetchPublicUrl("https://public.example/");
  expect(await response.text()).toBe("public content");
  expect(lookups).toBe(1);
  expect(requests[0].options.agent).toBe(false);
  answers = [{ address: "127.0.0.1", family: 4 }];
  let actual: any;
  requests[0].options.lookup(
    "public.example",
    {},
    (_error: unknown, address: string, family: number) =>
      (actual = { address, family }),
  );
  expect(actual).toEqual({ address: "1.1.1.1", family: 4 });
});
test("redirect to a private address is blocked before any second connection", async () => {
  responses = [
    { status: 302, location: "http://169.254.169.254/latest/meta-data/" },
  ];
  await expect(fetchPublicUrl("https://public.example/")).rejects.toThrow(
    "Private or reserved",
  );
  expect(requests.length).toBe(1);
});
test("DNS changes at a redirect are validated and blocked", async () => {
  responses = [{ status: 302, location: "https://redirect.example/" }];
  // Change the DNS response after the first request was made.
  const promise = fetchPublicUrl("https://public.example/");
  await Promise.resolve();
  await Promise.resolve();
  answers = [{ address: "10.0.0.1", family: 4 }];
  await expect(promise).rejects.toThrow("Private or reserved");
  expect(requests.length).toBe(1);
});
test("response size is bounded before returning attacker content", async () => {
  responses = [{ status: 200, body: "x".repeat(100) }];
  await expect(
    fetchPublicUrl("https://public.example/", { maxBytes: 10 }),
  ).rejects.toThrow("size limit");
});
test("redirect loops terminate at the configured bound", async () => {
  responses = Array.from({ length: 3 }, () => ({
    status: 302,
    location: "/again",
  }));
  await expect(
    fetchPublicUrl("https://public.example/", { redirects: 2 }),
  ).rejects.toThrow("Too many");
  expect(requests.length).toBe(3);
});
test("stalled DNS cannot occupy a preview worker indefinitely", async () => {
  stalledDns = true;
  await expect(
    fetchPublicUrl("https://public.example/", { timeoutMs: 10 }),
  ).rejects.toThrow("DNS lookup timed out");
  expect(requests.length).toBe(0);
});

test('an expired absolute deadline opens neither DNS nor a socket', async () => {
  await expect(fetchPublicUrl('https://public.example/', { deadline: Date.now() - 1 })).rejects.toThrow('timed out');
  expect(lookups).toBe(0);
  expect(requests).toHaveLength(0);
});
test('an absolute deadline cannot be renewed by a fresh fetch timeout', async () => {
  stalledDns = true;
  const start = Date.now();
  await expect(fetchPublicUrl('https://public.example/', { deadline: start + 20, timeoutMs: 5000 })).rejects.toThrow('DNS lookup timed out');
  expect(Date.now() - start).toBeLessThan(500);
  expect(requests).toHaveLength(0);
});
