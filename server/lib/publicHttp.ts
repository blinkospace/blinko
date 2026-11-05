import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";

// Explicit prefix arithmetic also works on deployed Bun versions whose
// node:net BlockList implementation does not enforce IPv4 entries correctly.
const ipv4Number = (address: string) =>
  address.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);
const inPrefix = (value: number, network: number, prefix: number) => {
  const size = 2 ** (32 - prefix);
  return Math.floor(value / size) === Math.floor(network / size);
};
const blockedV4 = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
].map(([address, prefix]) => [ipv4Number(address as string), Number(prefix)] as const);
const blockedV6 = [
  [0x20010000, 23], [0x20010db8, 32], [0x20020000, 16], [0x3fff0000, 20],
] as const;

export function isPublicAddress(address: string) {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    return !blockedV4.some(([network, prefix]) => inPrefix(value, network, prefix));
  }
  if (family !== 6) return false;
  // Every IPv6 range used here is at most /32. A missing second hextet
  // represents compression and is zero; leading compression lies outside /3.
  const [first, second] = address.split(':');
  const value = parseInt(first || '0', 16) * 65536 + parseInt(second || '0', 16);
  return inPrefix(value, 0x20000000, 3) &&
    !blockedV6.some(([network, prefix]) => inPrefix(value, network, prefix));
}

export async function resolvePublicUrl(
  input: string,
  resolver = lookup,
  timeoutMs = 5000,
) {
  if (timeoutMs <= 0) throw new Error("Remote request timed out");
  const url = new URL(input);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Only public HTTP(S) URLs are allowed");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await Promise.race([
        resolver(hostname, { all: true, verbatim: true }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("DNS lookup timed out")),
            Math.max(1, timeoutMs),
          );
        }),
      ]).finally(() => clearTimeout(timer));
  if (
    !addresses.length ||
    addresses.some(({ address }) => !isPublicAddress(address))
  )
    throw new Error("Private or reserved destinations are not allowed");
  return { url, address: addresses[0] };
}

// Bound caller wait as well as transport time (including time in a limiter queue).
export async function withPublicRequestDeadline<T>(deadline: number, operation: () => Promise<T>): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Remote request timed out");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Remote request timed out")), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Pin the validated DNS result to the socket and revalidate every redirect. Do
// not use an ambient HTTP proxy that could resolve the destination differently.
export async function fetchPublicUrl(
  input: string,
  options: { maxBytes?: number; timeoutMs?: number; redirects?: number; deadline?: number } = {},
) {
  let target = input;
  const deadline = Math.min(options.deadline ?? Infinity, Date.now() + (options.timeoutMs ?? 5000));
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  for (let hop = 0; hop <= (options.redirects ?? 5); hop++) {
    const { url, address } = await resolvePublicUrl(
      target,
      lookup,
      deadline - Date.now(),
    );
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Remote request timed out");
    const result = await new Promise<{
      status: number;
      headers: Headers;
      buffer: Buffer;
    }>((resolve, reject) => {
      const request = (url.protocol === "https:" ? https : http).get(
        url,
        {
          agent: false,
          headers: {
            Accept:
              "text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5",
            "Accept-Encoding": "identity",
          },
          lookup: (_host, opts: any, callback: any) => {
            if (opts?.all) callback(null, [address]);
            else callback(null, address.address, address.family);
          },
        },
        (response) => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(response.headers))
            if (value !== undefined)
              headers.set(key, Array.isArray(value) ? value.join(", ") : value);
          const status = response.statusCode ?? 500;
          if ([301, 302, 303, 307, 308].includes(status)) {
            response.destroy();
            resolve({ status, headers, buffer: Buffer.alloc(0) });
            return;
          }
          const chunks: Uint8Array[] = [];
          let size = 0;
          response.on("data", (chunk) => {
            size += chunk.length;
            if (size > maxBytes)
              request.destroy(new Error("Remote response exceeds size limit"));
            else chunks.push(new Uint8Array(chunk));
          });
          response.on("end", () =>
            resolve({ status, headers, buffer: Buffer.concat(chunks) }),
          );
          response.on("error", reject);
        },
      );
      const timer = setTimeout(
        () => request.destroy(new Error("Remote request timed out")),
        remaining,
      );
      request.on("close", () => clearTimeout(timer));
      request.on("error", reject);
    });
    if ([301, 302, 303, 307, 308].includes(result.status)) {
      const location = result.headers.get("location");
      if (!location) throw new Error("Invalid remote redirect");
      target = new URL(location, url).href;
      continue;
    }
    return {
      status: result.status,
      ok: result.status >= 200 && result.status < 300,
      headers: result.headers,
      url: url.href,
      arrayBuffer: async () => result.buffer,
      text: async () => result.buffer.toString("utf8"),
      json: async () => JSON.parse(result.buffer.toString("utf8")),
    };
  }
  throw new Error("Too many remote redirects");
}
