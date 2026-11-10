import { expect, test } from 'bun:test';
import { REFERENCE_DATABASE_SUITES, referenceTestDatabase, serviceSuiteEnvironment } from '../../scripts/plugin-services-test-config';

const standard = 'postgresql://blinko_test:synthetic-ci-password@127.0.0.1:5432/blinko_plugin_services_test?connection_limit=8';
const reference = 'postgresql://candidate_owner:synthetic-reference-password@127.0.0.1:5432/candidate_owned?connection_limit=6';
const fixture = { PLUGIN_SERVICES_TEST_DB: '1', DATABASE_URL: standard, PLUGIN_SERVICES_REFERENCE_DATABASE_URL: reference };

test('every qualification/reference suite receives its dedicated database and guard, without mutating the parent', () => {
  for (const name of REFERENCE_DATABASE_SUITES) {
    const env = serviceSuiteEnvironment(name, fixture);
    expect(env.DATABASE_URL).toBe(reference);
    expect(env.B_CANDIDATE_PROBE).toBe('1');
  }
  expect(fixture.DATABASE_URL).toBe(standard);
  expect('B_CANDIDATE_PROBE' in fixture).toBe(false);
});
test('legacy database suites keep the standard database and are not opted into the candidate guard', () => {
  const env = serviceSuiteEnvironment('db-vector-query.test.ts', fixture);
  expect(env.DATABASE_URL).toBe(standard);
  expect(env.B_CANDIDATE_PROBE).toBeUndefined();
});
test('a missing reference URL never silently routes the new suites to the standard database', () => {
  expect(() => serviceSuiteEnvironment('db-note-qualification.test.ts', { PLUGIN_SERVICES_TEST_DB: '1', DATABASE_URL: standard })).toThrow();
});
test('an explicitly guarded ordinary-owner harness remains supported', () => {
  const env = serviceSuiteEnvironment('db-reference-process.test.ts', { PLUGIN_SERVICES_TEST_DB: '1', B_CANDIDATE_PROBE: '1', DATABASE_URL: reference });
  expect(env.DATABASE_URL).toBe(reference);
});
test('reference routing rejects foreign hosts, other roles/databases and non-PostgreSQL URLs', () => {
  for (const value of [reference.replace('127.0.0.1', 'example.invalid'), reference.replace('candidate_owner', 'blinko_test'), reference.replace('/candidate_owned', '/existing_notes'), reference.replace('postgresql:', 'https:')]) {
    expect(() => referenceTestDatabase({ ...fixture, PLUGIN_SERVICES_REFERENCE_DATABASE_URL: value })).toThrow();
  }
});
test('the explicit reference URL does not bypass the isolated-test flag', () => {
  expect(() => referenceTestDatabase({ ...fixture, PLUGIN_SERVICES_TEST_DB: '0' })).toThrow();
});
test('the single-connection ledger case retains its standard database and process-local pool limits', () => {
  const env = serviceSuiteEnvironment('db-ledger-pool.pool_test.ts', fixture);
  const url = new URL(env.DATABASE_URL!);
  expect(url.username).toBe('blinko_test');
  expect(url.searchParams.get('connection_limit')).toBe('1');
  expect(url.searchParams.get('pool_timeout')).toBe('2');
  expect(new URL(fixture.DATABASE_URL).searchParams.get('connection_limit')).toBe('8');
});
