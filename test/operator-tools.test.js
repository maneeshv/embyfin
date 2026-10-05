import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { configFromPlan } from '../ops/deploy-config.mjs';
import { checkedFiles } from '../ops/private-context.mjs';

test('deployment generation rejects changes, unknown outputs and unsafe configuration', () => {
  const config = { account_id: '1'.repeat(32), routes: [{ pattern: 'media.test.invalid' }], d1_databases: [{ database_id: 'test-db' }], workers_dev: false, preview_urls: false, assets: { run_worker_first: true }, vars: { CF_ACCOUNT_ID: '1'.repeat(32), CF_DATABASE_ID: 'test-db', APP_ORIGIN: 'https://media.test.invalid', ACCESS_ISSUER: 'https://team.cloudflareaccess.com', ACCESS_AUD: 'test-aud', OWNER_EMAIL: 'owner@test.invalid', SOURCE_ENDPOINT: 'https://source.invalid', SOURCE_BUCKET: 'test-source' } };
  const plan = { resource_changes: [{ mode: 'managed', change: { actions: ['no-op'] } }], planned_values: { outputs: { wrangler_config: { value: config } } } };
  assert.equal(configFromPlan(plan), config);
  assert.throws(() => configFromPlan({ ...plan, resource_changes: [{ mode: 'managed', change: { actions: ['update'] } }] }));
  assert.throws(() => configFromPlan({ ...plan, output_changes: { wrangler_config: { after_unknown: { vars: true } } } }));
  assert.throws(() => configFromPlan({ ...plan, resource_changes: [{ mode: 'managed', change: { actions: ['no-op'], importing: { id: 'test' } } }] }));
  config.vars.CF_DATABASE_ID = 'wrong-db';
  assert.throws(() => configFromPlan(plan));
  config.vars.CF_DATABASE_ID = 'test-db';
  for(const key of ['TMDB_READ_TOKEN','OPENSUBTITLES_API_KEY','OPENSUBTITLES_TOKEN','OPENSUBTITLES_USERNAME','OPENSUBTITLES_PASSWORD','PROVIDER_ENCRYPTION_KEY']) {
    config.vars[key]='must-not-export';
    assert.throws(()=>configFromPlan(plan));
    delete config.vars[key];
  }
  config.vars.MACHINE_SECRET = 'must-not-export';
  assert.throws(() => configFromPlan(plan));
});

test('archive allowlist refuses symlinks, traversal and private decryption keys', () => {
  const dir = mkdtempSync('.context-test-');
  try {
    writeFileSync(`${dir}/safe`, 'context');
    assert.deepEqual(checkedFiles([`${dir}/safe`]), [`${dir}/safe`]);
    symlinkSync('safe', `${dir}/link`);
    assert.throws(() => checkedFiles([`${dir}/link`]));
    assert.throws(() => checkedFiles([`${dir}/../package.json`]));
    writeFileSync(`${dir}/key`, 'AGE-SECRET-' + 'KEY-' + 'A'.repeat(59));
    assert.throws(() => checkedFiles([`${dir}/key`]));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
