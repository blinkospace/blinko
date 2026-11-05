import { fileURLToPath } from "node:url";
import path from "node:path";

// Bun module mocks are process-wide. Isolate suites so one route fixture cannot
// accidentally supply another suite's database or transport implementation.
const cwd = fileURLToPath(new URL("..", import.meta.url));
for (const suite of [
  "policies",
  "attachment-binding",
  "file-urls",
  "exports",
  "file-storage",
  "oauth-callback",
  "pending-two-factor",
  "authorization",
  "http-auth",
  "http-files",
  "public-http",
  "public-runtime",
  "public-routes",
  "plugin",
  "mcp",
  "mcp-process",
]) {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "test",
      path.join("__tests__/security", `${suite}.test.ts`),
    ],
    { cwd, stdout: "inherit", stderr: "inherit" },
  );
  if (result.exitCode !== 0) process.exit(result.exitCode || 1);
}
