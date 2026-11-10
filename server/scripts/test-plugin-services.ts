import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { REFERENCE_DATABASE_SUITES, referenceTestDatabase, serviceSuiteEnvironment } from './plugin-services-test-config';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.env.PLUGIN_SERVICES_TEST_DB !== "1" || !process.env.DATABASE_URL) {
  console.error(
    "Plugin services tests require an explicitly isolated real PostgreSQL database. Set PLUGIN_SERVICES_TEST_DB=1 and DATABASE_URL.",
  );
  process.exit(1);
}
const discovered = readdirSync(path.join(server, "__tests__/pluginServices"))
  .filter((file) => file.endsWith(".test.ts"))
  .sort()
  .concat("db-ledger-pool.pool_test.ts");
const requested = new Set(process.argv.slice(2));
if ([...requested].some((file) => !discovered.includes(file)))
  throw new Error("Unknown plugin services suite requested.");
const suites = discovered.filter((file) => !requested.size || requested.has(file));
if (!suites.length) throw new Error("No plugin services suites found.");
// Validate before any suite runs; a missing reference fixture is never a skip.
if (suites.some(file => REFERENCE_DATABASE_SUITES.has(file))) referenceTestDatabase(process.env);
let failed = 0;
for (const file of suites) {
  const databaseGroup = REFERENCE_DATABASE_SUITES.has(file) ? 'reference-owner' : 'standard';
  console.log(`Plugin services suite: ${file} [database: ${databaseGroup}]`);
  const env = serviceSuiteEnvironment(file, process.env);
  const child = spawnSync(
    process.execPath,
    ["test", path.join("__tests__/pluginServices", file)],
    { cwd: server, env, stdio: ["inherit", "pipe", "pipe"], timeout: 120000, maxBuffer: 16 * 1024 * 1024 },
  );
  const stdout = child.stdout?.toString() ?? "";
  const stderr = child.stderr?.toString() ?? "";
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  const summary = stdout + stderr;
  const passed = Number(summary.match(/^\s*(\d+) pass\s*$/m)?.[1] ?? 0);
  const failures = summary.match(/^\s*(\d+) fail\s*$/m);
  if (child.status !== 0 || child.signal || child.error || passed < 1 || !failures || Number(failures[1]) !== 0) {
    failed++;
    console.error({
      suite: file,
      status: child.status,
      signal: child.signal,
      error: child.error?.message,
    });
  }
}
console.log(
  `Plugin services: ${suites.length - failed}/${suites.length} isolated suites passed.`,
);
process.exitCode = failed ? 1 : 0;
