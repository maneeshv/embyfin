// Run from the repository root. Credentials come only from the environment.
import { AwsClient } from 'aws4fetch';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, lstatSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function checkedFiles(files) {
  for (const file of files) {
    if (file.startsWith('/') || file.split('/').some(p => p === '..' || !p)) throw Error('Unsafe archive path');
    const parts = file.split('/');
    for (let i = 1; i <= parts.length; i++) {
      if (lstatSync(parts.slice(0, i).join('/')).isSymbolicLink()) throw Error('Archive symlinks are forbidden');
    }
    if (!lstatSync(file).isFile()) throw Error('Archive entries must be regular files');
    if (/AGE-SECRET-KEY-[A-Z0-9]{50,}/.test(readFileSync(file).toString('utf8'))) throw Error('Archive contains an age private key');
  }
  return files;
}

async function main() {
  process.umask(0o077);
  const mode = process.argv[2] ?? 'context';
  if (!['context', 'recovery'].includes(mode)) throw Error('Usage: node ops/private-context.mjs [context|recovery]');
  const config = JSON.parse(readFileSync('.private/archive-config.json'));
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== 'https:' || !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(endpoint.hostname) || endpoint.pathname !== '/' || endpoint.search || endpoint.username || endpoint.password || endpoint.port) throw Error('Expected a standard HTTPS R2 endpoint');
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket)) throw Error('Invalid archive bucket');
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) throw Error('Load R2 backend credentials first');
  mkdirSync('.private/archive-receipts', { recursive: true, mode: 0o700 });
  const files = ['deployment.md', 'acceptance.md', 'terraform.tfvars', 'backend.hcl', 'recovery-recipient.txt', 'archive-config.json', 'identifiers.json'].map(f => `.private/${f}`);
  for (const name of readdirSync('.private/archive-receipts')) {
    if (/^[a-zA-Z0-9.-]+\.json$/.test(name)) files.push(`.private/archive-receipts/${name}`);
  }
  if (mode === 'recovery') {
    // Explicit recovery inputs, never all of .wrangler or the workspace.
    files.push('.dev.vars', '.wrangler/terraform.env', '.wrangler/terraform-backend.env', '.private/state.tfstate', '.private/source.bundle');
    const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
    for (const name of [...new Set([...tracked, 'plan.md', 'ops/private-context.mjs', 'ops/deploy-config.mjs', 'ops/check-public.py', 'ops/test_public_check.py', 'test/operator-tools.test.js', 'docs/PRIVATE-CONTEXT.md', 'infra/terraform/backend.hcl.example'])]) {
      try { lstatSync(name); files.push(name); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const original = `.private/original/${name}`;
      try { lstatSync(original); files.push(original); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  checkedFiles(files);
  const temp = mkdtempSync(join(tmpdir(), 'embyfin-context-'));
  const id = `${new Date().toISOString().replace(/[:]/g, '-')}-${randomUUID()}`;
  const key = `${mode === 'recovery' ? 'recovery' : 'deployment-context'}/${id}.tar.gz.age`;
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  try {
    const archive = join(temp, 'context.tar.gz');
    execFileSync('tar', ['-czf', archive, '--', ...files]);
    execFileSync('age', ['-R', '.private/recovery-recipient.txt', '-o', `${archive}.age`, archive]);
    const bytes = readFileSync(`${archive}.age`);
    const client = new AwsClient({ accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, service: 's3', region: 'auto', retries: 0 });
    const url = new URL(`/${config.bucket}/${key}`, endpoint);
    const put = await client.fetch(url, { method: 'PUT', headers: { 'If-None-Match': '*', 'Content-Type': 'application/octet-stream' }, body: bytes, signal: AbortSignal.timeout(120000) });
    if (!put.ok) throw Error(`R2 upload failed (${put.status}); existing objects were not overwritten`);
    const get = await client.fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!get.ok || sha(Buffer.from(await get.arrayBuffer())) !== sha(bytes)) throw Error('Uploaded archive failed download verification');
    const receipt = { bucket: config.bucket, key, sha256: sha(bytes), bytes: bytes.length, sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), workingTreeDirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), files, transferVerifiedAt: new Date().toISOString(), decryptionVerifiedAt: null };
    writeFileSync(`.private/archive-receipts/${id}.json`, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(`Encrypted ${mode} archive uploaded and download checksum verified. Receipt saved privately. Decryption verification is pending.`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
