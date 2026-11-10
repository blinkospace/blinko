import { test, expect } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.env.PLUGIN_SERVICES_TEST_DB !== "1" || !process.env.DATABASE_URL)
  throw new Error("Dedicated real PostgreSQL is required.");
const target = new URL(process.env.DATABASE_URL);
if (!["127.0.0.1", "localhost"].includes(target.hostname) || target.username !== "blinko_test")
  throw new Error("Test database boundary failed.");

test("new migration applies, rolls back without business data loss, and reapplies on real PostgreSQL", async () => {
  const prisma = new PrismaClient();
  const schema = "plugin_services_test_" + crypto.randomUUID().replaceAll("-", "");
  const sql = readFileSync(
    fileURLToPath(
      new URL(
        "../../../prisma/migrations/20261108083000_plugin_services/migration.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  const rateSql = readFileSync(
    fileURLToPath(
      new URL(
        "../../../prisma/migrations/20261108110000_plugin_service_rate/migration.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  const statements = (sql + "\n" + rateSql)
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  const tables = [
    "plugin_service_rate",
    "plugin_service_requests",
    "plugin_service_daily_usage",
    "plugin_service_policy",
  ];
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      await tx.$executeRawUnsafe("CREATE TABLE business_marker(id int primary key, value text)");
      await tx.$executeRawUnsafe("INSERT INTO business_marker VALUES(1,'synthetic-existing-data')");
      for (const statement of statements) await tx.$executeRawUnsafe(statement);
      const created = await tx.$queryRaw<
        Array<{ table_name: string }>
      >`SELECT table_name FROM information_schema.tables WHERE table_schema=${schema}`;
      expect(tables.every((table) => created.some((row) => row.table_name === table))).toBe(true);
      for (const table of tables) await tx.$executeRawUnsafe(`DROP TABLE "${table}"`);
      expect(await tx.$queryRawUnsafe("SELECT value FROM business_marker")).toEqual([
        { value: "synthetic-existing-data" },
      ]);
      for (const statement of statements) await tx.$executeRawUnsafe(statement);
      const recreated = await tx.$queryRaw<
        Array<{ n: bigint }>
      >`SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=${schema}`;
      expect(Number(recreated[0].n)).toBe(5);
      await tx.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    });
  } finally {
    await prisma.$disconnect();
  }
});
