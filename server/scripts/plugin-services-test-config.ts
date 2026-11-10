/** Database selection for isolated service suites. Never relax a suite's guards. */
export const REFERENCE_DATABASE_SUITES = new Set([
  'db-note-qualification.test.ts',
  'db-reference-process.test.ts',
  'db-reference-snapshots.test.ts',
]);

type Environment = Record<string, string | undefined>;

export function referenceTestDatabase(source: Environment): URL {
  const value = source.PLUGIN_SERVICES_REFERENCE_DATABASE_URL ??
    (source.B_CANDIDATE_PROBE === '1' ? source.DATABASE_URL : undefined);
  if (source.PLUGIN_SERVICES_TEST_DB !== '1' || !value)
    throw new Error('Reference suites require an explicit isolated reference database.');
  let database: URL;
  try { database = new URL(value); }
  catch { throw new Error('Invalid isolated reference database configuration.'); }
  if (!['postgres:', 'postgresql:'].includes(database.protocol) ||
      database.hostname !== '127.0.0.1' || database.username !== 'candidate_owner' ||
      database.pathname !== '/candidate_owned')
    throw new Error('Reference suites require the loopback candidate_owner/candidate_owned database.');
  return database;
}

export function serviceSuiteEnvironment(file: string, source: Environment): Environment {
  if (source.PLUGIN_SERVICES_TEST_DB !== '1' || !source.DATABASE_URL)
    throw new Error('Service suites require explicit isolated PostgreSQL configuration.');
  const env = { ...source };
  if (REFERENCE_DATABASE_SUITES.has(file)) {
    env.DATABASE_URL = referenceTestDatabase(source).toString();
    env.B_CANDIDATE_PROBE = '1';
  }
  if (file === 'db-ledger-pool.pool_test.ts') {
    const database = new URL(env.DATABASE_URL!);
    database.searchParams.set('connection_limit', '1');
    database.searchParams.set('pool_timeout', '2');
    env.DATABASE_URL = database.toString();
  }
  return env;
}
