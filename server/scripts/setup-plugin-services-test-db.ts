import assert from 'node:assert/strict';
import pg from 'pg';
import { referenceTestDatabase } from './plugin-services-test-config';

// CI/local fixtures only. This creates a new ordinary-owner database; it never
// drops, truncates or reuses an existing database or changes an existing role.
const primary = new URL(process.env.DATABASE_URL ?? '');
const reference = referenceTestDatabase(process.env);
assert.equal(process.env.PLUGIN_SERVICES_TEST_DB, '1');
assert(['postgres:', 'postgresql:'].includes(primary.protocol));
assert.equal(primary.hostname, '127.0.0.1');
assert.equal(primary.username, 'blinko_test');
assert.equal(primary.pathname, '/blinko_plugin_services_test');
assert.equal(reference.host, primary.host, 'Both isolated databases must use the same local fixture server.');
const password = decodeURIComponent(reference.password);
assert(/^[A-Za-z0-9_-]{1,128}$/.test(password), 'Reference fixture password must use the synthetic fixture alphabet.');
const admin = new pg.Client({ connectionString: primary.toString() });
await admin.connect();
try {
  const roles = await admin.query("SELECT 1 FROM pg_roles WHERE rolname='candidate_owner'");
  const databases = await admin.query("SELECT 1 FROM pg_database WHERE datname='candidate_owned'");
  assert.equal(roles.rowCount, 0, 'Refuse to change an existing reference role.');
  assert.equal(databases.rowCount, 0, 'Refuse to reuse an existing reference database.');
  // The restricted alphabet above is intentional: CREATE ROLE cannot bind its
  // PASSWORD literal as a query parameter. Never interpolate arbitrary input.
  await admin.query("CREATE ROLE candidate_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '" + password + "'");
  await admin.query('CREATE DATABASE candidate_owned OWNER candidate_owner');
} finally { await admin.end(); }
const owner = new pg.Client({ connectionString: reference.toString() });
await owner.connect();
try {
  const { rows } = await owner.query('SELECT current_user AS name, rolsuper, rolcreatedb, rolcreaterole, rolreplication FROM pg_roles WHERE rolname=current_user');
  assert.equal(rows[0].name, 'candidate_owner');
  for (const key of ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication']) assert.equal(rows[0][key], false);
  console.log(JSON.stringify({ referenceDatabaseCreated: true, database: 'candidate_owned', role: rows[0] }));
} finally { await owner.end(); }
