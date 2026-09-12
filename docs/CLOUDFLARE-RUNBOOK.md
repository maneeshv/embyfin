# Cloudflare deployment runbook

This is a reusable procedure. Keep account/resource IDs, deployment versions, owner identity, token expiry and actual verification results in `.private/deployment.md` and `.private/acceptance.md`. Back them up using [private context recovery](PRIVATE-CONTEXT.md).

## Choose the procedure

| Situation | Procedure |
|---|---|
| Release code to intact infrastructure | Redeploy below; reuse resources and secrets |
| New installation or infrastructure adoption | Use [Terraform](../infra/terraform/README.md) |
| Recover catalog, grants or personal state | Use [data recovery](RECOVERY.md); a scan cannot restore user state |

Preserve originals and unrelated services. Terraform owns D1, derived buckets and Access. Wrangler owns Worker releases, bindings, custom domain attachment, Cron, Containers and Durable Objects. Browser steps below describe the manual fallback and prerequisites; avoid dashboard edits to Terraform-managed resources that a later apply could revert.

## Account, plan and storage

1. Verify the intended account, active DNS zone and Workers Paid plan. Containers require an eligible plan.
2. Establish the Zero Trust team and a one-time PIN login provider. Record its ID; shared identity providers remain outside this stack.
3. Create or adopt the D1 catalog and separate poster/backup R2 buckets. Keep derived buckets private, development URLs disabled and public custom domains absent.
4. Reuse originals with a bucket-scoped Object Read only S3 credential. Do not bind originals with write authority or create an empty replacement bucket.
5. Choose an unused hostname in the active zone. Wrangler's custom-domain route attaches it; a manual tunnel or A/CNAME record is not required by this setup. Resolve ownership if another service uses it.
6. Bootstrap separate private Terraform state storage, then configure the private inputs described in the Terraform guide.

## Browser Access application

Configure a self-hosted application on the exact application hostname, with an empty path:

| Setting | Value |
|---|---|
| Session | 24 hours |
| Policy | Allow; include individually approved email identities |
| Login method | Selected one-time PIN provider only; auto redirect enabled |
| Launcher | Visible |
| Cookie | HTTPOnly enabled; binding cookie disabled |
| WARP/path-cookie/preflight | No additional bypass or authentication options |

Record the browser application's AUD and the team's issuer. The Worker independently validates Access JWT signatures, issuer and audience. Access admission does not replace enabled application identities and library grants. Changing the owner email does not transfer an existing user's role.

## Processor callback Access application

Configure a separate self-hosted application on the exact `HOSTNAME/machine/*` destination. Its policy is Bypass with Everyone included, and its launcher entry is hidden. Do not attach that policy to the browser application or broaden it to `/*`.

When entering the dashboard path, use `machine/*` and verify the destination has a single slash. Machine endpoints still require expiring signed run credentials and valid run/job leases. Keep the Worker's Access audience set to the browser application, not this machine application. No Access service token is needed for this design.

## Credentials and operator access

| Worker secret | Purpose |
|---|---|
| `SOURCE_ACCESS_KEY_ID` | Bucket-scoped source S3 access key |
| `SOURCE_SECRET_ACCESS_KEY` | Matching Object Read only secret |
| `CF_API_TOKEN` | Account D1 Edit token for consistent SQL export |
| `MACHINE_SECRET` | Cryptographically random secret of at least 32 bytes |

Create source credentials through R2's API-token management. Restrict them to the source bucket and Object Read only. Inspect the policy; successful reads alone do not prove write authority is absent. Create a separate export token with D1 Edit on the intended account; that authority may affect other databases in the account.

Terraform operator credentials and Wrangler's OAuth login are separate from runtime secrets. Store scopes, expiry and recreation notes privately. An authenticated Wrangler session does not necessarily have token-creation authority.

For a new local secret file only:

```sh
python3 - <<'PY'
import os, secrets
from pathlib import Path
with os.fdopen(os.open('.dev.vars', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as output:
    output.write(Path('.dev.vars.example').read_text().replace('MACHINE_SECRET=', 'MACHINE_SECRET=' + secrets.token_hex(32), 1))
PY
```

Fill remaining values in a protected editor and preserve a recovery copy. Never put secrets in browser assets, Terraform inputs, generated vars or Container images. The Docker build context allowlist includes only processor files. The processor receives a temporary run token, not long-lived source credentials.

Rotate only project credentials. Verify replacements before retiring old credentials. Rotating the machine secret requires stopping processing and letting existing leases expire.

## Redeploy an existing installation

Use Node 22.13+, npm, Python 3.9+, FFmpeg/FFprobe and a Linux/amd64-capable Docker daemon. Run from the repository root:

```sh
npm ci
npm test
npm run check
npm run build
npm run build:processor
# Load trusted Terraform/backend environment files as described in the Terraform guide.
npm run config
# Review generated configuration privately, including processing and maintenance flags.
npm run deploy
```

`npm run deploy` generates configuration from a fresh plan and uses Wrangler OAuth for the release. Log in separately if needed. A normal release needs no SQL imports, initial migrations, resource recreation, new libraries or secret rotation. Before a schema migration, independently verify a current consistent backup.

The template is not a deployment target. `--keep-vars` preserves additional remote variables, and deployed secret bindings are retained independently of that flag. Explicitly clear temporary settings such as `PROCESSING_SAMPLE` rather than omitting them. A Worker upload and Container rollout are not an atomic transaction; verify both.

## First deployment

1. Provision/adopt infrastructure and generate configuration.
2. Verify the selected catalog is intentionally empty before applying initial migrations:

   ```sh
   ./node_modules/.bin/wrangler d1 migrations apply DB --remote --config wrangler.generated.json
   ```

3. Clear the Terraform token when using Wrangler OAuth. Deploy generated configuration with `--secrets-file .dev.vars --keep-vars` for the first release only.
4. Sign in as the configured owner, validate the source connection and create non-overlapping libraries using boundary preview. Start each approved library's scan; creating it alone does not start scanning.
5. Keep processing disabled until a representative sample and budgets are accepted. Inventory can finish while posters remain pending.
6. Verify a fresh backup after onboarding. New users require both Access admission and enabled app accounts with library grants.

## Verify deployment and operation

Use Wrangler with `--config wrangler.generated.json` to inspect deployments, secret names, Container applications and instances. Confirm the expected domain, bindings, one-minute Cron and successful scheduled invocations. Record versions and image digests privately.

Unsigned browser/API requests should encounter Access; an unsigned machine request should receive an authentication rejection from the app. A machine redirect indicates the Access path may be wrong. Do not print cookies, run tokens or source credentials in diagnostics.

Sign in and verify Library, Folders, Settings, scan progress, playback/seek, poster delivery and account switching. Check disabled-user and cross-library denial. Inspect aggregate job counts and fresh heartbeats; a successful Worker deployment alone does not prove the processor works.

Default limits are in the public template: one instance, bounded per-job reads, job/batch deadlines, and daily backup scheduling. These do not cap monthly spending. Backups gate traffic while leases drain and exports complete. Configure and verify independent backup-age, absent-schedule and budget alerts; retain results privately.

## Controlled poster test

Keep full processing disabled until a production sample succeeds. Copy the generated production Wrangler config to ignored `wrangler.canary.json` in the repository root. Preserve resource bindings and the deployed Container image digest; `--containers-rollout=none` avoids an image rollout for a Worker-only change.

Set these temporary variables in that copy:

```json
{
  "PROCESSING_ENABLED": "true",
  "PROCESSING_SAMPLE": "{\"ids\":[\"VIDEO_UUID\"],\"until\":UNIX_EXPIRY_SECONDS}",
  "JOB_SECONDS": "30",
  "JOB_READ_LIMIT": "33554432",
  "BATCH_SECONDS": "150"
}
```

Replace the placeholders with one to three current video IDs and an absolute expiry ten minutes ahead. Dispatch and claims both enforce the allowlist; invalid configuration fails closed. The expiry precedes the next 15-minute dispatch, preventing a second automatic batch. Each job retains its maximum of three attempts. These are resource limits, not a dollar spending cap.

Deploy with `wrangler deploy --config wrangler.canary.json --keep-vars --containers-rollout=none`. Observe Worker tail, Container logs, `processor_runs` and the selected jobs. Check poster keys/metadata, elapsed time, CPU, memory, source bytes and requests, errors, and that no other job's attempt count increased. Do not select run tokens in diagnostic output.

After the sample, deploy the ordinary production settings with `PROCESSING_ENABLED=false` and explicitly set `PROCESSING_SAMPLE` to an empty string (because `--keep-vars` preserves omitted variables). Verify the run is stopped and the instance inactive. Preserve results before another test. Do not enable the whole queue merely because the sample's limits worked.

## Troubleshooting and rollback

| Symptom | Check / action |
|---|---|
| Container deployment says Free plan is unsupported | Verify Workers Paid on the correct account. This blocked the first attempt and was resolved by the operator's upgrade. |
| Docker unavailable or `COPY processor/main.py` fails | Start Docker; retain repository-root `image_build_context: "."` and run from the repo root. Both issues occurred during setup. |
| Deployment failed after Worker upload | Inspect the active Worker version, secrets and Container application. Our initial upload activated before the Container build failed; the command is not an all-or-nothing transaction. Fix the build and redeploy, then verify both. |
| Access login works but API returns 401 | Match issuer/team and the main application's AUD; verify owner login and HTTPOnly cookie settings. |
| Admitted user receives 403 or an empty library | Check enabled app identity and library grants separately from Access admission. Restored subjects may need deliberate identity reconciliation. |
| No videos after deployment | Check each library's explicit first scan, pause state, source credentials, scan errors and scheduled invocations. Creating a library alone does not start it. |
| Videos have placeholders / pending metadata | Expected with `PROCESSING_ENABLED=false`. A completed inventory does not imply FFmpeg jobs ran. |
| Processor exits before claiming, with `network` | Check `machine_request_failed` HTTP status and `machine_connection_failed` diagnostics. Python's default `Python-urllib/3.12` user agent received HTTP 403 from the edge; the explicit `Embyfin-Processor/0.1` identity reaches application authentication. Keep this identity on machine callbacks; no Access/WAF policy change is needed for that fix. |
| Docker build/push hangs in `docker-credential-desktop` | Inspect only the project build's helper processes. An isolated mode-0700 `DOCKER_CONFIG` directory with a mode-0600 config avoids the hanging Desktop credential helper. Use the existing daemon endpoint and remove its temporary registry credentials after upload. Preserve the ordinary Docker configuration. |
| Scan activity is overdue | Check Cron logs, library pause, source connection and backup maintenance. Do not create overlapping replacement libraries to bypass a stuck scan. |
| Backup stale or app stuck in backup maintenance | Inspect `control/backup.json` independently and follow [A stuck export](RECOVERY.md#a-stuck-export). Do not clear the gate merely because a timeout elapsed. |

For code rollback, redeploy a preserved, known-good source revision with the intended production config and existing secrets, then repeat verification. Account for its Container image and D1 schema compatibility; a Worker version rollback does not restore database state. If schema or data must be reverted, use the isolated restore procedure. Leave the serving database and original videos intact while preparing recovery.
