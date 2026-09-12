# Operator recovery runbook

Keep this file, deployment identifiers, and independent Cloudflare operator credentials outside the database and application. R2 originals are **not backed up** by Embyfin. Posters are regenerable. Backups in the same Cloudflare account do not protect against account-wide loss.

Use the [Cloudflare deployment runbook](CLOUDFLARE-RUNBOOK.md) for Access policies, credential recreation and deployment commands; keep installation IDs in `.private/deployment.md`. The [acceptance record](ACCEPTANCE.md) lists the required restore checks. Select the latest suitable completed recovery point; retain verification evidence in the private acceptance record.

## Daily operation

The singleton controller gates requests and jobs using `control/backup.json` in the private backup bucket, destroys the processor, then waits at least 100 seconds for pre-gate leases/requests to drain. It polls the provider's consistent D1 SQL export API, copies SQL in 5 MiB multipart chunks while hashing, and only then publishes a per-export manifest and `lastComplete`. Manifests contain bytes, SHA-256, schema version, timestamp and bookmark. No FTS tables are present. Backup files older than the 30-day retention window are removed only from `daily/` in the backup bucket. The operator permits cleanup of Embyfin-owned data; unrelated Cloudflare resources and original videos must remain untouched.

Exports have a provisional 512 MiB copy ceiling and bounded HTTP timeouts. A failed/uncertain export keeps maintenance closed and records an error outside D1; investigate rather than assuming normal service resumed. Retry/poll state is in R2. Per the provider, an export can cancel if it is no longer polled. Validate polling cadence and actual export duration in the account before release.

The provisional RPO is 24 hours and RTO is 4 hours after operator action. These are acceptance targets, not measured guarantees.

## Independent health monitoring

Use independent Cloudflare operator credentials to download `BACKUP_BUCKET/control/backup.json` through R2/CLI, then run:

```sh
umask 077
mkdir -p .wrangler/recovery
./node_modules/.bin/wrangler r2 object get BACKUP_BUCKET/control/backup.json --remote --config wrangler.generated.json --file .wrangler/recovery/backup.json
python3 ops/check-backup.py .wrangler/recovery/backup.json
```

Run from the repository root after the operator login described in the deployment runbook. Read `lastComplete.key` from the downloaded control manifest, then download that SQL object and its adjacent `<key>.json` manifest into the same private directory. Verify both with `python3 ops/check-backup.py .wrangler/recovery/export.sql.json --sql .wrangler/recovery/export.sql`. Do not hard-code the initial drill's SQL key for future recovery.

Exit 2 means no valid recent backup. Configure an external scheduled monitor and Cloudflare notification delivery to alert on that failure, on `embyfin_backup_failed`/`embyfin_backup_stale` structured log events, **and on absent scheduled execution**. Do not monitor only the D1-backed settings page. Verify alert delivery by feeding a manifest older than 24 hours while the app is unavailable. Alert destination/account policy is deployment configuration; no messages or external monitors are created by local development.

## Restore without the application

1. Enable `MAINTENANCE=true` through deployment configuration or put `control/maintenance.json` (any JSON object) in the private backup bucket using independent operator credentials. This check runs before D1 access. Stop Cron triggers and destroy the named processor in the Cloudflare control plane; wait for active source responses to end. Access admission alone is not a substitute for the maintenance gate.
2. Download a completed SQL file and its `.sql.json` manifest. Verify it with `python3 ops/check-backup.py manifest.json --sql export.sql`. If using an older recovery point intentionally, verify SHA-256/bytes separately and explicitly record the failed RPO; never call it a healthy daily backup.
3. Create a **new isolated D1 database** in the dashboard or with `wrangler d1 create RESTORE_DB --config wrangler.generated.json`, replacing `RESTORE_DB` with a unique recovery database name. Record its new ID. Save this minimal operator configuration as `.wrangler/restore-config.json`, replacing both placeholders and using the actual account ID if restoring elsewhere:

   ```json
   {
     "name": "embyfin-restore-operator",
     "account_id": "REPLACE_WITH_ACCOUNT_ID",
     "d1_databases": [{
       "binding": "DB",
       "database_name": "RESTORE_DB",
       "database_id": "REPLACE_WITH_NEW_ISOLATED_DATABASE_ID"
     }]
   }
   ```

   Confirm that ID differs from the serving database ID in `wrangler.generated.json`. Import the verified export using independent operator credentials:

   ```sh
   ./node_modules/.bin/wrangler d1 execute DB --remote --config .wrangler/restore-config.json --file .wrangler/recovery/export.sql
   ```

   Do not import into the serving database. D1 Time Travel is an alternative **in-place overwrite**, not a clone operation; keep maintenance on for that route too.
4. On the isolated restore, run `ops/recover.sql`:

   ```sh
   ./node_modules/.bin/wrangler d1 execute DB --remote --config .wrangler/restore-config.json --file ops/recover.sql
   ```

   It invalidates every run/job/playback lease, cancels scans, pauses libraries, disables all restored viewers, and removes restored grants. Favorites and progress remain. This conservative default prevents a grant revoked after the export from silently returning.
5. Run `ops/verify-restore.sql`. Compare canonical counts, selected favorites/progress, exact object keys, schema version, and owner mapping with the manifest/drill record. All `_must_be_zero` checks must be zero. Use two disjoint test users to verify metadata, folders, counts, search, poster, media and state denial. Use `--command` to obtain SELECT rows: Wrangler's remote `--file` import reports import metadata rather than the result rows. An example using a separately prepared operator config bound **only to the isolated restore**:

   ```sh
   python3 - <<'PY'
   from pathlib import Path
   import subprocess
   subprocess.run([
       './node_modules/.bin/wrangler', 'd1', 'execute', 'DB', '--remote',
       '--config', '.wrangler/restore-config.json',
       '--command=' + Path('ops/verify-restore.sql').read_text(), '--json',
   ], check=True)
   PY
   ```
6. Reconcile each viewer against a current independently maintained authorization record; if none exists, require explicit owner reapproval. Re-admit/enable and regrant only approved people. Check the current Access policy separately. Do not assume all restored account state still reflects current permission.
7. Change **both** the serving `d1_databases[0].database_id` and backup `vars.CF_DATABASE_ID` in the deployment configuration to the verified database, then deploy while maintenance remains on. If Terraform has adopted this installation, first [reconcile its catalog state to the restored database](../infra/terraform/README.md#recovery-when-terraform-owns-d1) and regenerate `wrangler.generated.json`; otherwise prepare and verify a replacement operator configuration. Leave the old database intact until recovery is accepted. Recheck schema, owner sign-in and disabled viewer denial. Clear old Container durable `active` state by stopping the controller; its next tick also destroys/reconciles any stale instance before dispatch.
8. Remove `control/maintenance.json` or set `MAINTENANCE=false`, resume Cron, and explicitly resume approved libraries. Source reconciliation uses exact HEAD checks and never deletes originals. A missing poster produces a placeholder. Take a new verified backup.

Record export blocking time, restore duration, exact recovery point, comparison counts, current-policy reconciliation, two-user isolation, and received stale-backup alert. Run the drill while the owner UI is unavailable. Only accept the PRD recovery target after those measurements pass.

## A stuck export

Read `control/backup.json` directly from R2 and examine provider export status using the stored bookmark. Fix credentials/networking and let bounded polling resume. If cancelling, confirm the provider export has completed or cancelled, destroy processing, and then set that control manifest's status to `failed`, preserving `lastComplete` and its failure details. Never reopen based solely on a timeout, and never delete the last known good backup. A migration must not run until a new consistent backup has passed checksum verification.


## Encrypted deployment context and workstation recovery

See [private deployment context](PRIVATE-CONTEXT.md) for encrypted R2 checkpoints, the private file layout, and replacement-workstation instructions. Store archive locations, checksums, verification dates and the age recipient in private records, not this repository. The decryption key must remain in the operator vault and outside every archive.
