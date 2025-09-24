/**
 * Instantiates a single instance PrismaClient and save it on the global object.
 * @see https://www.prisma.io/docs/support/help-articles/nextjs-prisma-client-dev-practices
 */
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSQLite3 } from '@prisma/adapter-better-sqlite3';



// Determine database type and configuration
const DATABASE_TYPE = process.env.DATABASE_TYPE || 'postgres';
const isPostgres = DATABASE_TYPE === 'postgres';
const isSQLite = DATABASE_TYPE === 'sqlite';

// Set up database URL based on type
let databaseUrl = process.env.DATABASE_URL;
let adapter: PrismaBetterSQLite3
if (isSQLite && !databaseUrl) {
  adapter = new PrismaBetterSQLite3({
    url:  "file:../server/.blinko/sqlite/sqlite.db"
  });
}

const prismaGlobal = globalThis as typeof globalThis & {
  prisma?: PrismaClient;
};
export const prisma: PrismaClient =
  prismaGlobal.prisma ??
  new PrismaClient({
    ...(adapter && { adapter }),
    log:
      process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
    datasources: {
      db: {
        url: databaseUrl
      }
    }
  });

if (process.env.NODE_ENV !== 'production') {
  prismaGlobal.prisma = prisma;
}