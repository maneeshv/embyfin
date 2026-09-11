# Cloudflare deployment runbook

Verified against the deployed account and repository on **2026-09-11 UTC**. This records the browser setup as well as the CLI deployment. Use [release acceptance](ACCEPTANCE.md) for test evidence and [recovery](RECOVERY.md) for restoring data.

**Terraform is now available:** use [infra/terraform](../infra/terraform/README.md) to adopt the existing D1/R2/Access resources or provision a new installation. It includes recorded imports, deletion protection and generated Wrangler configuration. Wrangler continues to own application/Container releases. The browser steps below remain the manual fallback and historical configuration record; live Terraform adoption completed on 2026-09-11, with a clean follow-up plan.

## Choose the procedure

| Situation | Procedure |
|---|---|
| Deploy code again; existing Cloudflare resources are intact | Follow **Redeploy an existing installation**. Reuse the database, buckets, Access applications and secrets. |
| Recreate missing infrastructure or install in another account | Follow **Recreate the browser configuration**, **Credentials**, then **First deployment**. Replace generated identifiers in the config. |
| Recover catalog, users, favorites or progress | Follow [RECOVERY.md](RECOVERY.md). Import into an isolated database before switching production. A fresh scan cannot restore personal state. |

Only Embyfin-owned resources may be changed or cleaned up. Preserve `windows-video-archive` and unrelated applications, buckets, policies and DNS. No original videos were uploaded, moved or deleted during setup.

## Resource inventory and ownership

These IDs identify the current installation; new resources get new IDs. The executable configuration is [wrangler.jsonc](../wrangler.jsonc).

| Resource | Current value | How it was established |
|---|---|---|
| Cloudflare account | `x-video-downloader-project` / `a58958f1af472b99313d58370ff74638` | Existing account |
| Workers plan | Workers Paid | Operator upgraded after the Free plan blocked Containers |
| Zone | `embyfin.uk` / `b647657aef0a74857a5752edb2d7cd50` | Existing active zone; no domain purchase performed |
| Application | `https://media.embyfin.uk`, Worker `embyfin` | Wrangler deployed Worker, assets, custom domain and HTTPS attachment |
| D1 / binding `DB` | `embyfin` / `45db29f5-b8cb-40a0-9263-12e0a6319d6a` | Created in browser; initial migration applied with Wrangler |
| Original videos | `windows-video-archive` | Existing bucket; app accesses it through read-only S3 credentials |
| Posters / binding `POSTERS` | `embyfin-posters` | Created in browser; Standard, automatic placement, private |
| Backups / binding `BACKUPS` | `embyfin-backups` | Created in browser; Standard, automatic placement, private |
| Zero Trust team | `orange-sky-811f.cloudflareaccess.com` | Existing team; Free plan was already configured |
| Shared one-time PIN provider | `x-downloader - Cloudflare Workers` / `29c185f9-e40f-4302-b883-534ec008570f` | Existing provider; ID verified in browser for Terraform inputs; not managed by Terraform |
| Browser Access application | `Embyfin` / `553b565e-41c6-4350-8fd5-fcb68d6354a6` | Created in browser |
| Browser Allow policy | `Embyfin owner` / `c09c9d9a-a9b6-4de0-8142-1c2544729975` | Created in browser |
| Machine Access application | `Embyfin processor` / `70cba25e-bad9-4997-b90b-990f33e9d26c` | Created in browser |
| Machine Bypass policy | `Embyfin processor callbacks` / `a30174a4-46de-4661-8ac1-37dbb8ce5f65` | Created in browser; attached only to machine application |
| Container application | `embyfin-mediacontroller` / `a038b6cc-adf5-4dd5-b333-9c18ed676b55` | Created by Wrangler |
| Durable Object | `MediaController`, binding `PROCESSOR`, instance name `media` | Created by Wrangler migration `v1` |
| Durable Object namespace | `97b105e93beb485b82546fcedab46173` | Generated; not an ID to hard-code into a new deployment |
| Cron | `* * * * *` | Deployed from Wrangler; one-minute scheduler |
| Observability | Enabled | Deployed from Wrangler |
| Restore drill database | `embyfin-restore-check-20260911` / `61d7e5c1-bf9b-4cbf-a70d-1d25bd13bd4a` | Created with CLI for a drill; retained, never bound to production |

Last successful Worker version: `852a16d7-571a-4593-b38e-201da5d0aeb6`.

Last uploaded processor image:

```text
registry.cloudflare.com/a58958f1af472b99313d58370ff74638/embyfin-mediacontroller@sha256:9ace8efb4ea98850cfb48ee926cd3f92436e2cb2cd5eda39425869ba0ddf3333
```

Update this record after a deployment. Source rebuilds can produce a different image because the Docker base image and OS packages are not pinned by digest.

## Recreate the browser configuration

Skip resources that already exist. Dashboard labels can move; the desired values below are the reference.

### 1. Account, plan and storage

1. Open the [account dashboard](https://dash.cloudflare.com/a58958f1af472b99313d58370ff74638/home) and verify the account ID. Under [Workers plans](https://dash.cloudflare.com/a58958f1af472b99313d58370ff74638/workers/plans), verify Workers Paid is active. The original deployment could not create Containers on Free.
2. Under **Storage & databases → D1 → Create database**, create `embyfin` if absent. Automatic location was used; the original database was placed in APAC/SIN. Record its database ID.
3. Under **R2 Object Storage → Create bucket**, create `embyfin-posters` and `embyfin-backups` if absent, with Standard storage and automatic placement (APAC was displayed). Keep their public development URLs disabled and add no public custom domains.
4. Reuse the existing originals bucket. Do not create a replacement empty bucket or put posters/backups inside it. The deployment has no R2 binding with write authority to the originals.
5. Verify `embyfin.uk` is an active zone in this account. The hostname `media.embyfin.uk` was unused before deployment. Wrangler's `custom_domain: true` route attaches the hostname; no manual A/CNAME record or Cloudflare Tunnel was created. If the hostname now belongs to another service, resolve ownership before attaching it.

Wrangler recreates the Worker, assets, bindings, Container application/image, Durable Object namespace, Cron and custom domain from the config. [Terraform](../infra/terraform/README.md) now covers the D1/R2 resources and Access policies/applications above. Account billing, shared identity-provider setup, token issuance and external alert delivery remain operator prerequisites.

### 2. Browser Access application

Open [Zero Trust → Access controls → Applications](https://dash.cloudflare.com/a58958f1af472b99313d58370ff74638/one/access-controls/apps). Add a **Self-hosted** application, or inspect the existing **Embyfin** application:

| Field | Required configuration |
|---|---|
| Name | `Embyfin` |
| Public hostname | Subdomain `media`, domain `embyfin.uk`, **Path empty** |
| Session duration | 24 hours |
| Policy | `Embyfin owner`; action **Allow** |
| Include rule | Selector **Emails**; value `maneeshvettukattil@gmail.com` |
| Accept all available identity providers | Off |
| Selected login method | Existing `x-downloader - Cloudflare Workers - onetimepin` only |
| Instant authentication | On; selected automatically with one login method |
| WARP authentication | Off |
| App Launcher visibility | On |
| HTTPOnly cookie | **On**; save under the application's cookie settings |
| Other cookie options | Binding cookie off; enforce cookie path off; remaining settings left at defaults |

The one-time PIN provider was reused without modifying its shared configuration. No new Google/OAuth provider was created. In a new Zero Trust account, configure a [one-time PIN login method](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/) first, then select it for this app.

After saving, open the main application's **Additional settings → AUD tag**. Copy that value to `ACCESS_AUD`. Current values:

```text
ACCESS_ISSUER=https://orange-sky-811f.cloudflareaccess.com
ACCESS_AUD=92235c0e8ec583d00921659367d54d3b0c96137d8a93030595272e21f0794f86
OWNER_EMAIL=maneeshvettukattil@gmail.com
```

The AUD is a public identifier, not a secret. Recreating the application changes it. Use the issuer for the actual Zero Trust team. Configure these before serving the app. The Worker independently verifies Access JWT signatures, issuer and audience.

### 3. Processor callback Access application

Create a **second Self-hosted** application with these settings:

| Field | Required configuration |
|---|---|
| Name | `Embyfin processor` |
| Public hostname | Subdomain `media`, domain `embyfin.uk`, Path **`machine/*`** |
| Exact destination preview | **`media.embyfin.uk/machine/*`** |
| Policy | `Embyfin processor callbacks`; action **Bypass** |
| Include rule | Selector **Everyone** |
| App Launcher visibility | Off |
| Session duration / other options | 24 hours / defaults; interactive login is bypassed on this path |

Enter the Path without a leading slash: entering `/machine/*` produced an incorrect double slash in the dashboard preview during setup. Do not attach this Bypass policy to the main application or broaden it to `/*`.

The more-specific application overrides Access on that path, as described in [Cloudflare's application path rules](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/). The Worker still requires its own expiring HS256 run credential and valid D1 run/job leases. No Cloudflare Access service token was created or required. Keep `ACCESS_AUD` set to the **browser** application's AUD.

### 4. Alerts and existing shared resources

The [Notifications page](https://dash.cloudflare.com/a58958f1af472b99313d58370ff74638/notifications) already had an enabled email notification named **Default budget alert (auto-created)**. It was left unchanged; its threshold, recipient and delivery were not validated. No independent backup-age or absent-Cron monitor was created. Follow [independent health monitoring](RECOVERY.md#independent-health-monitoring) to finish that work.

Existing `x-downloader` services, `x-downloader-videos`, other Access applications and the shared identity provider were not changed. No unrelated resource was deleted.

## Credentials and operator access

The operator created and saved the four production Worker credentials; they were uploaded by CLI. A separate Terraform operator token was later created through the authenticated browser with explicit approval (see below). Four Worker secret names are required:

| Secret | Purpose and recreation |
|---|---|
| `SOURCE_ACCESS_KEY_ID` | R2 S3 access key ID from a token restricted to `windows-video-archive` |
| `SOURCE_SECRET_ACCESS_KEY` | Matching R2 S3 secret; **Object Read only** permission |
| `CF_API_TOKEN` | Account-owned Cloudflare API token with **Account → D1 → Edit** for this account; used for scheduled D1 export |
| `MACHINE_SECRET` | Cryptographically random 32 bytes or more; current format is 64 hex characters; signs short-lived processor run tokens |

For the source token, open **R2 overview → Account Details → API Tokens → Manage**, create an account token if your role permits (otherwise a user token), choose **Object Read only**, and select only `windows-video-archive`. Save the Access Key ID and Secret Access Key in a secure vault; the secret is shown only once. The endpoint is `https://a58958f1af472b99313d58370ff74638.r2.cloudflarestorage.com`. See [R2 token setup](https://developers.cloudflare.com/r2/api/tokens/). Successful reads were verified; they do not prove the supplied token lacks write permissions. Inspect its policy rather than testing writes against originals.

For the export token, open [Account API Tokens](https://dash.cloudflare.com/a58958f1af472b99313d58370ff74638/api-tokens), create a custom account token with D1 Edit, and scope it to this account. Use an Embyfin-specific token and record its name, scope and expiry in the operator vault. Do not assume D1 Edit is limited to one database: account-level authority may include other D1 databases. Its export operation has been verified on `embyfin`.

Terraform operator token **`embyfin-terraform`** (ID `7ae72f413d5990b55c44e08711176151`, verified Active) was created in **Manage account → Account API tokens → Create → Start from scratch**, with account-wide **D1 Edit**, **Workers R2 Storage Edit**, and **Access: Apps and Policies Edit** on this account. The new editor labels the last group **Access**, whose description covers applications and policies. Choose **90 days**; the created token displays expiry **December 11, 2026**, with no IP restriction. Review the exact scope before creation. Save `CLOUDFLARE_API_TOKEN` in ignored `.wrangler/terraform.env` (mode 0600), separately from `.dev.vars`; never upload it to the Worker. Its permissions were verified by the successful live Terraform adoption. Preserve a vault copy and rotate before expiry.

Wrangler operator login is separate from all four runtime secrets. `wrangler login` authorized deployment/resource management here, but token-creation API calls returned 403 with that OAuth session. Token creation via the Cloudflare API needs separate token-management authority; an existing CLI login is not sufficient evidence of it.

For a **new local secret file only**, this creates an ignored, mode-0600 template and a random machine secret without printing it. It refuses to overwrite an existing file:

```sh
python3 - <<'PY'
import os, secrets
from pathlib import Path
template = Path('.dev.vars.example').read_text()
with os.fdopen(os.open('.dev.vars', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as output:
    output.write(template.replace('MACHINE_SECRET=', 'MACHINE_SECRET=' + secrets.token_hex(32), 1))
PY
```

Fill the other three values in a local editor and preserve a secure recovery copy. Never commit `.dev.vars`, place secrets in `wrangler.jsonc`/browser assets, or include them in the Container image. Root [.dockerignore](../.dockerignore) restricts the build context to the processor files. The processor gets a temporary run token, not these secrets.

For routine redeploys, reuse the existing Worker secrets. If a token is lost or expires, create an Embyfin-specific replacement, deploy it, verify its read/export operation, then retire only the old Embyfin credential. Rotating `MACHINE_SECRET` invalidates active run credentials; stop processing first and allow leases to expire before resuming.

## Redeploy an existing installation

Run commands from the repository root. Prerequisites: Node 22.13+, npm, Python 3.9+, FFmpeg/FFprobe for checks, and a running Docker daemon capable of building Linux/amd64. The lockfile used Wrangler 4.131.0 at this checkpoint; use `npm ci` to install the recorded dependencies.

```sh
export WRANGLER_LOG_PATH=/private/tmp/embyfin-deploy.log
export WRANGLER_SEND_METRICS=false
npm ci
./node_modules/.bin/wrangler login
./node_modules/.bin/wrangler whoami
docker info
npm test
npm run check
npm run build
npm run build:processor
```

On Linux use a writable temporary path such as `/tmp/embyfin-deploy.log`. Skip login if `whoami` already confirms the intended operator/account. On macOS, start Docker Desktop if `docker info` cannot reach the daemon.

Review [wrangler.jsonc](../wrangler.jsonc), especially the account, hostname, D1 ID, Access values, bucket names, maintenance and processing flags. A normal code redeploy does not require importing SQL, rerunning initial schema SQL, recreating Access, or rotating secrets. Before any later schema migration, obtain and independently verify a consistent backup using [RECOVERY.md](RECOVERY.md).

```sh
./node_modules/.bin/wrangler deploy --config wrangler.jsonc --keep-vars
```

The command rebuilds/publishes the Container when needed. Keep `image_build_context: "."`: the Dockerfile copies `processor/main.py` relative to the repository root. `--keep-vars` preserves additional remotely configured variables; existing secret bindings are preserved by deployments independently of that flag. A normal redeploy needs no local secret values. See [Worker secret deployment behavior](https://developers.cloudflare.com/workers/configuration/secrets/).

Do not use `wrangler.local.jsonc` for production. `npm run build` is a Worker dry-run and does not deploy the Container. The production `deploy` command above does both; complete the verification below before declaring success.

## First deployment or replacement infrastructure

1. Complete the browser configuration and credentials above. Existing source access is a prerequisite; this procedure does not copy or back up originals into a new account.
2. Update `account_id` and `vars.CF_ACCOUNT_ID`; update **both** `d1_databases[0].database_id` and `vars.CF_DATABASE_ID` to the intended database. The first controls serving; the second controls export. Update names/bindings if replacement resources were named differently.
3. Set `APP_ORIGIN` and `routes[0].pattern` to the new hostname, and the actual `ACCESS_ISSUER`, browser `ACCESS_AUD`, `OWNER_EMAIL`, `SOURCE_ENDPOINT`, `SOURCE_BUCKET` and `SOURCE_SCOPE`. Keep `workers_dev: false`, `preview_urls: false`, and `assets.run_worker_first: true`. Start with `PROCESSING_ENABLED: "false"`.
4. For an intentionally **new empty catalog**, verify the bound database is empty, then apply the initial migration. For recovery of existing state, use [RECOVERY.md](RECOVERY.md) instead; do not apply initial schema creation over an imported database.

```sh
./node_modules/.bin/wrangler d1 execute embyfin --remote --config wrangler.jsonc --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
./node_modules/.bin/wrangler d1 migrations apply embyfin --remote --config wrangler.jsonc
```

5. Run the prerequisites and checks from the redeployment section. With all four secrets populated in `.dev.vars`, upload them with the initial Worker version:

```sh
./node_modules/.bin/wrangler deploy --config wrangler.jsonc --secrets-file .dev.vars --keep-vars
```

6. Verify the deployment before onboarding. In Settings, use **Validate connection**. This reads the source and writes/deletes a probe only in the Embyfin poster bucket. Sign in using the configured owner email; an empty database bootstraps that owner on first admitted sign-in. Existing restored identities require reconciliation if the Zero Trust team/provider changed; changing `OWNER_EMAIL` does not transfer ownership or promote an existing user.
7. For a fresh catalog, create the intended non-overlapping libraries in Settings using boundary preview. The current layout is one library per prefix: `Categories/`, `Gimgyrl/`, `Movies/`, `Random/`, `Stars/`, `Studios/`, `TV/`, `Unsorted/`. Start the first scan for each approved library. This freezes that library's source/prefix and enables daily refresh. Do not recreate already restored libraries. The one-minute Cron advances scans after the browser closes.
8. A viewer needs both Access admission and an enabled app account with library grants. The current Access policy admits only the owner. Add individually approved emails to that app's Allow policy when sharing is intended; configure grants separately in Embyfin Settings.
9. Keep processing off until representative runtime/device checks and the budget are accepted. Scanning can populate the Library while thumbnail/codec jobs remain pending. Take a new backup after onboarding via Settings → **Back up now**, wait for completion and verify it independently.

## Verify deployment and operation

Read-only operator checks:

```sh
./node_modules/.bin/wrangler deployments list --config wrangler.jsonc
./node_modules/.bin/wrangler secret list --config wrangler.jsonc
./node_modules/.bin/wrangler containers list --config wrangler.jsonc
./node_modules/.bin/wrangler containers instances a038b6cc-adf5-4dd5-b333-9c18ed676b55 --config wrangler.jsonc
./node_modules/.bin/wrangler d1 execute embyfin --remote --config wrangler.jsonc --command="SELECT version FROM schema_info; SELECT l.name,l.prefix,l.frozen,l.paused,(SELECT count(*) FROM videos v WHERE v.library_id=l.id AND v.available=1) AS videos FROM libraries l ORDER BY l.name; SELECT s.status,s.discovered,s.ignored,s.error,l.name FROM scans s JOIN libraries l ON l.id=s.library_id ORDER BY s.started_at DESC LIMIT 16; SELECT state,count(*) AS jobs FROM jobs GROUP BY state;"
```

Use the new application ID from `containers list` if recreating infrastructure. `secret list` should show the four names above without values. Check the [Worker dashboard](https://dash.cloudflare.com/a58958f1af472b99313d58370ff74638/workers/services/view/embyfin/production) for active deployment, custom domain, bindings, Cron and successful scheduled invocations. Container inactivity is expected while processing is disabled. Worker deployment success alone does not prove a Container workload succeeds; see [Container deployment checks](https://developers.cloudflare.com/containers/guides/deploy/).

Without sending browser cookies, these checks should report Access redirects (`302`) for browser/API URLs and app rejection (`401`) for the unsigned machine URL. Do not follow redirects or print authentication cookies:

```sh
for embyfin_path in / /app.js /api/session /api/admin /machine/claim; do
  curl --silent --show-error --output /dev/null --write-out '%{http_code} %{url_effective}\n' "https://media.embyfin.uk${embyfin_path}"
done
```

Then sign in and confirm Settings and Library load, scan status progresses, and the owner sees the catalog. An unsigned machine request returning 302 indicates the machine Access path is wrong; 200 would also be unexpected. The previous signed stale-run check returned `409 stale_run`. After deployment, retain the new Worker version, Container digest and verification date in this runbook/acceptance record.

Current operating settings in Wrangler:

| Setting | Value / effect |
|---|---|
| `PROCESSING_ENABLED` | `false`; catalog scans work, enrichment remains queued |
| Container | `standard-2`, maximum one instance |
| Job source read limit | 268,435,456 bytes (256 MiB) |
| Job / batch deadline | 120 seconds / 600 seconds |
| Dispatch / shutdown | At most every 15 minutes; 60-second idle timeout and hard-stop deadline |
| Backup hour | `2` UTC, daily (07:30 Asia/Kolkata), driven by the one-minute Cron |
| Backup retention / copy ceiling | 30 days / 512 MiB SQL export |
| Maintenance | Normally `false`; external R2 maintenance gate also supported |

These bound individual workloads, not total monthly spending. Daily backup briefly gates the application while leases drain and SQL exports; the initial observed pause/export/copy took 117 seconds. Monitor completion independently of D1. Downloads, checksum checks and recovery are in [RECOVERY.md](RECOVERY.md).

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
| Scan activity is overdue | Check Cron logs, library pause, source connection and backup maintenance. Do not create overlapping replacement libraries to bypass a stuck scan. |
| Backup stale or app stuck in backup maintenance | Inspect `control/backup.json` independently and follow [A stuck export](RECOVERY.md#a-stuck-export). Do not clear the gate merely because a timeout elapsed. |

For code rollback, redeploy a preserved, known-good source revision with the intended production config and existing secrets, then repeat verification. Account for its Container image and D1 schema compatibility; a Worker version rollback does not restore database state. If schema or data must be reverted, use the isolated restore procedure. Leave the serving database and original videos intact while preparing recovery.

## What must survive loss of this workstation

- A preserved source revision containing `src/`, `public/`, `processor/`, `migrations/`, `ops/`, docs, Wrangler configs, Docker files, `package.json` and `package-lock.json`. The implementation, Terraform configuration and runbooks are preserved on the `codex/recovery-and-remote-state` branch in the private `maneeshv/embyfin` GitHub repository. Credentials, state and real tfvars are excluded.
- Independent Cloudflare account access, recovery/MFA methods, domain administration, and a secure vault copy of the four secrets with token names/scopes/expiry. Their vault location and independent recovery access have not been verified. Deployed secret values cannot be recovered from this runbook or D1 exports.
- Completed SQL exports and manifests, plus a current authorization record outside D1. The first verified backup predates the library setup and scans; do not mistake it for a backup of today's 31-video catalog. Obtain and verify a new post-scan backup.
- Access policy/team/AUD records and the resource inventory above, kept outside the serving app. Existing same-account R2 backups do not cover loss of the Cloudflare account; originals are not backed up by Embyfin.

Terraform adoption completed: seven resources imported, two disabled R2 development URL settings added, zero existing resources changed or destroyed; the follow-up plan was clean. State now lives in private R2 bucket `embyfin-terraform-state`, key `production/terraform.tfstate`, with native lockfiles. This bootstrap bucket is outside the application Terraform stack, has no application binding and must remain private without expiration. A current local copy is `.wrangler/terraform-remote.tfstate.backup`. The remote plan is clean and R2 conditional lock writes were tested. Follow the [backend and recovery instructions](../infra/terraform/README.md#credentials-and-state); the encrypted recovery archive is verified in R2; the owner confirmed saving its key in 1Password and the temporary local key file was removed. See [recovery instructions](RECOVERY.md#encrypted-workstation-recovery-archive). No CI/CD integration, external backup monitor or notification delivery test was configured. Preserve the source, lockfiles, Terraform state and independent credentials for recovery.
