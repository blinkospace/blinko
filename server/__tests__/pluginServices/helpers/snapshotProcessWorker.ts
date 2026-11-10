import { createClient } from "@libsql/client";
import { VectorSnapshotStore } from "../../../services/pluginServices/VectorSnapshotStore";
const url = process.argv[2],
  accountId = Number(process.argv[3]);
if (
  !url?.startsWith("file:") ||
  !Number.isSafeInteger(accountId) ||
  accountId < 1
)
  throw new Error("Local synthetic snapshot fixture required");
// Test-only fault attribution: distinguish failed read/BEGIN/body/COMMIT without
// changing transaction semantics or retrying a completed operation.
function instrument<T extends object>(value: T, prefix: string): T {
  return new Proxy(value, {
    get(target, key) {
      const fn = Reflect.get(target, key);
      if (typeof fn !== "function") return fn;
      if (
        !["execute", "transaction", "commit", "rollback"].includes(String(key))
      )
        return fn.bind(target);
      return async (...args: unknown[]) => {
        try {
          const result = await fn.apply(target, args);
          return key === "transaction"
            ? instrument(result, "transaction")
            : result;
        } catch (error) {
          const tagged = error as { snapshotStage?: string };
          tagged.snapshotStage ??= `${prefix}.${String(key)}`;
          throw error;
        }
      };
    },
  });
}
const raw = createClient({ url });
try {
  const handle = await new VectorSnapshotStore(
    instrument(raw, "client"),
  ).reserve(accountId);
  console.log(
    JSON.stringify({ pid: process.pid, accountId, handle, code: "OK" }),
  );
} catch (error) {
  const detail = error as {
    code?: string;
    snapshotStage?: string;
    message?: string;
  };
  console.log(
    JSON.stringify({
      pid: process.pid,
      accountId,
      code: detail.code ?? "ERROR",
      stage: detail.snapshotStage,
      message: detail.message,
    }),
  );
} finally {
  raw.close();
}
