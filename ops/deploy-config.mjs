// Generate from a fresh read-only plan, not possibly stale outputs in state.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function configFromPlan(plan) {
  if (plan.errored || plan.complete === false || plan.deferred_changes?.length) throw Error('Terraform plan is incomplete');
  if ((plan.resource_changes ?? []).some(r => r.mode === 'managed' && (r.change.actions.join(',') !== 'no-op' || r.change.importing))) throw Error('Review and apply infrastructure changes before generating deployment config');
  const output = plan.output_changes?.wrangler_config;
  if (output?.after_unknown && JSON.stringify(output.after_unknown).includes('true')) throw Error('Deployment outputs are not yet known');
  const config = plan.planned_values?.outputs?.wrangler_config?.value;
  if (!config || !/^[a-f0-9]{32}$/.test(config.account_id) || /^0+$/.test(config.account_id)) throw Error('Missing real deployment account');
  const v = config.vars;
  if (!v || ['APP_ORIGIN', 'ACCESS_ISSUER', 'ACCESS_AUD', 'OWNER_EMAIL', 'SOURCE_ENDPOINT', 'SOURCE_BUCKET', 'CF_DATABASE_ID'].some(k => !v[k])) throw Error('Missing deployment values');
  if (/example\.(com|org|net)|REPLACE_|YOUR-|your-team/.test(JSON.stringify(config))) throw Error('Replace deployment placeholders');
  if (v.CF_ACCOUNT_ID !== config.account_id || v.CF_DATABASE_ID !== config.d1_databases?.[0]?.database_id || v.APP_ORIGIN !== `https://${config.routes?.[0]?.pattern}`) throw Error('Inconsistent deployment bindings');
  if (config.workers_dev !== false || config.preview_urls !== false || config.assets?.run_worker_first !== true) throw Error('Private deployment protections are missing');
  for (const key of ['MACHINE_SECRET', 'CF_API_TOKEN', 'SOURCE_ACCESS_KEY_ID', 'SOURCE_SECRET_ACCESS_KEY']) if (key in v) throw Error('Runtime secrets must not appear in generated vars');
  return config;
}

function main() {
  process.umask(0o077);
  const args = process.argv.slice(2);
  if (args.some(a => a !== '--deploy')) throw Error('Usage: node ops/deploy-config.mjs [--deploy]');
  readFileSync('.private/terraform.tfvars');
  mkdirSync('.private', { recursive: true, mode: 0o700 });
  const planPath = '../../.private/deployment.tfplan';
  try {
    execFileSync('terraform', ['-chdir=infra/terraform', 'plan', '-input=false', '-lock-timeout=30s', '-var-file=../../.private/terraform.tfvars', `-out=${planPath}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const plan = JSON.parse(execFileSync('terraform', ['-chdir=infra/terraform', 'show', '-json', planPath], { maxBuffer: 32 * 1024 * 1024 }));
    const config = configFromPlan(plan);
    writeFileSync('.private/generated.tmp', JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    renameSync('.private/generated.tmp', 'wrangler.generated.json');
    console.log('Generated protected wrangler.generated.json; no infrastructure changes applied.');
  } finally {
    rmSync('.private/deployment.tfplan', { force: true });
    rmSync('.private/generated.tmp', { force: true });
  }
  if (args.includes('--deploy')) {
    // Terraform's infra token lacks Worker permissions. Use Wrangler's operator login.
    const env = { ...process.env };
    delete env.CLOUDFLARE_API_TOKEN;
    execFileSync('./node_modules/.bin/wrangler', ['deploy', '--config', 'wrangler.generated.json', '--keep-vars'], { env, stdio: 'inherit' });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    // Terraform failures may include private values. Keep detailed logs out of stdout.
    if (error.stderr) {
      mkdirSync('.private', { recursive: true, mode: 0o700 });
      writeFileSync('.private/config-error.log', error.stderr, { mode: 0o600 });
      console.error('Configuration generation failed; see .private/config-error.log. Existing config was not deployed.');
    } else console.error(error.message);
    process.exitCode = 1;
  }
}
