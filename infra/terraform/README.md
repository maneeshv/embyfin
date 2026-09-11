# Embyfin Terraform

Terraform owns the infrastructure previously created in the Cloudflare browser. Wrangler owns application releases. This avoids two tools overwriting the same Worker configuration.

| Owner | Resources |
|---|---|
| Terraform | D1 catalog; poster and backup buckets; disabled R2 development URLs; owner Allow policy and browser Access application; processor Bypass policy and its `/machine/*` application |
| Wrangler | Worker code/assets/secrets, Container image/application, Durable Object namespace/migrations, bindings, Cron, observability and custom domain/DNS attachment |
| Existing prerequisites | Cloudflare account, Workers Paid, active DNS zone, Zero Trust team, shared one-time PIN provider, original videos and operator credentials |

Originals in `windows-video-archive`, the shared identity provider, unrelated services and the isolated restore drill database are **not Terraform resources**. There is no provisioner that executes SQL, deletes objects or deploys code. All managed resources have `prevent_destroy`; this blocks replacement/destruction while those resource declarations remain in the configuration. It does not protect against deleting their declarations or changes made outside Terraform.

## Credentials and state

Use Terraform 1.10+ and the pinned Cloudflare provider 5.24.0. Preserve [.terraform.lock.hcl](.terraform.lock.hcl) with the source. The operator token for Terraform needs these permissions on account `a58958f1af472b99313d58370ff74638`:

- Account → **D1 → Edit**.
- Account → **Workers R2 Storage → Edit**.
- Account → **Access: Apps and Policies → Edit**.

The API/provider calls describe these as D1 Write, Workers R2 Storage Write and Access: Apps and Policies Write. Use a separate Embyfin infrastructure token, scope it to this account, and retain its expiry/reference in the operator vault. These are account-level management permissions; the token can affect resources beyond this Terraform configuration if used elsewhere. Do not give it to the Worker or broaden the runtime D1 export token. Provider authentication uses `CLOUDFLARE_API_TOKEN`; it does not use Wrangler's OAuth login. [Cloudflare provider authentication](https://registry.terraform.io/providers/cloudflare/cloudflare/5.24.0/docs).

Supply it through a password manager or, in an interactive Bash/Zsh shell, paste it into the hidden `read` input:

```sh
read -rs CLOUDFLARE_API_TOKEN
export CLOUDFLARE_API_TOKEN
```

No runtime secrets or token-creation resources are included in Terraform. Upload the four Worker secrets using the [deployment runbook](../../docs/CLOUDFLARE-RUNBOOK.md#credentials-and-operator-access).

State now uses the dedicated private **`embyfin-terraform-state`** R2 bucket, key **`production/terraform.tfstate`**, configured in [backend.tf](backend.tf). Native S3 lockfiles are enabled. R2 encrypts objects at rest automatically and the endpoint uses HTTPS; credentials stay in environment variables, not backend configuration. [R2 backend guide](https://developers.cloudflare.com/terraform/advanced-topics/remote-backend/) · [R2 data security](https://developers.cloudflare.com/r2/reference/data-security/).

Before Terraform commands, load the two locally generated, ignored credential files from the repository root (only source files you trust):

```sh
set -a
. .wrangler/terraform.env
. .wrangler/terraform-backend.env
set +a
terraform -chdir=infra/terraform init
```

`terraform.env` supplies `CLOUDFLARE_API_TOKEN`; `terraform-backend.env` supplies `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, the S3 form of that same approved operator token. Both files are mode 0600. Rotate both together before December 11, 2026; do not put either file in Git or the Worker. On another workstation restore these files from your vault, or supply equivalent environment variables. A dedicated bucket-scoped Object Read & Write credential may replace the backend credential independently later.

The backend bucket is a bootstrap prerequisite outside this stack, so application infrastructure changes cannot destroy its own state storage. Recreate it only if absent with `wrangler r2 bucket create embyfin-terraform-state` under the intended account; retain default private access, no public domains, no lifecycle expiration and no bucket retention lock on the mutable state/lock objects. Do not bind it to the application. For production recovery, restore the verified remote state backup before applying anything. Losing state requires reimporting resources; losing backend access does not delete infrastructure.

Migration on 2026-09-11 used `terraform init -migrate-state -force-copy` into the newly created empty bucket. **Do not use force-copy against an existing backend with unknown state.** All resource records and outputs matched the pre-migration copy; Terraform assigned a new backend lineage/serial, so use the post-migration backup going forward. The remote follow-up plan was clean and acquired/released its lock. A conditional-write collision test confirmed R2 rejects a second lock creation with HTTP 412; its temporary test object was removed.

A current local recovery copy is `.wrangler/terraform-remote.tfstate.backup`; pre-migration copies are retained for audit only. Refresh a protected recovery copy with `umask 077; terraform -chdir=infra/terraform state pull > .wrangler/terraform-remote.tfstate.backup`. An independently encrypted backup outside Cloudflare is still pending the operator's storage destination and recovery-key vault. Same-account R2 state does not cover Cloudflare account loss. Never store state under the application's expiring `daily/` backup prefix. Never force-unlock unless the original process is confirmed stopped.

## Adopt the existing production installation

Run from the repository root. Copy the example only if a local tfvars file does not already exist:

```sh
umask 077
cp -n infra/terraform/terraform.tfvars.example infra/terraform/terraform.tfvars
terraform -chdir=infra/terraform init
terraform -chdir=infra/terraform fmt -check
terraform -chdir=infra/terraform validate
terraform -chdir=infra/terraform plan -out=adopt.tfplan
terraform -chdir=infra/terraform show adopt.tfplan
```

The [example inputs](terraform.tfvars.example) contain the verified account, owner, hostname, team and existing one-time PIN provider ID. [imports.tf](imports.tf) imports **seven existing resources** by their recorded IDs: D1, two buckets, two Access policies and two Access applications. The default `adopt_existing=true` is guarded against using those imports on another account/hostname. Import blocks can remain after adoption.

The two `cloudflare_r2_managed_domain.private` resources do not support import in this provider version. Their initial plan shows **two creates**, which set `enabled=false` on the existing buckets' R2 development URLs; they do not create buckets or remove objects. Custom bucket domains are a separate mechanism: none were configured, and any future public-domain attachment must be reviewed separately. [Provider resource behavior](https://registry.terraform.io/providers/cloudflare/cloudflare/5.24.0/docs/resources/r2_managed_domain).

Review the entire plan before applying. Expect the seven imports and the two disabled-domain settings. Provider/default normalization may propose additional updates; resolve any differences against the [recorded browser settings](../../docs/CLOUDFLARE-RUNBOOK.md#recreate-the-browser-configuration). **Do not apply a plan that creates replacement buckets/databases/apps, removes resources, broadens Access or attaches the Bypass policy to the browser app.** Importing with `terraform apply` can also apply planned configuration changes; it is not inherently a read-only operation.

Once the concrete plan has been reviewed:

```sh
terraform -chdir=infra/terraform apply adopt.tfplan
terraform -chdir=infra/terraform plan
```

The follow-up plan should show no infrastructure changes. Save a secure state backup. Imports do not migrate, copy or reset catalog data. There is no need to run the initial database migration or restart scans during adoption.

After adoption, change managed settings in Terraform. For example, admitting a viewer requires adding their email to the Allow policy's `include` list in `main.tf` as well as enabling their account and grants in Embyfin. A later apply can revert edits made only in the Cloudflare dashboard.

## Deploy using Terraform's outputs

After infrastructure has been applied/imported, generate the deployment config from **applied state**:

```sh
terraform -chdir=infra/terraform output -json wrangler_config > wrangler.terraform.json
```

Generate this file at the repository root, where relative Worker, assets, migration and Docker paths resolve correctly. It merges the release settings from [wrangler.jsonc](../../wrangler.jsonc) with Terraform's account, hostname, owner, browser Access audience, bucket names and database ID. It fills **both** the serving database binding and the backup database ID. Source endpoint/bucket/scope and processing limits remain those in the base config; verify them when moving accounts.

Then use this config for all deployment and database commands for that installation. An infrastructure-only token lacks Worker deployment authority, so clear it before returning to Wrangler's operator OAuth session:

```sh
unset CLOUDFLARE_API_TOKEN
export WRANGLER_LOG_PATH=/private/tmp/embyfin-deploy.log
export WRANGLER_SEND_METRICS=false
./node_modules/.bin/wrangler whoami
./node_modules/.bin/wrangler deploy --config wrangler.terraform.json --keep-vars
```

Run `wrangler login` if required; on Linux use `/tmp/embyfin-deploy.log`. Complete the checks and Docker build from the [redeployment procedure](../../docs/CLOUDFLARE-RUNBOOK.md#redeploy-an-existing-installation). For a first deployment only, add `--secrets-file .dev.vars`. Keep changes to release settings in the base `wrangler.jsonc`, then regenerate the output. Do not hand-edit the generated file or deploy the old base config after changing infrastructure IDs/hostname.

## Create a new installation

1. Use a separate checkout. **Before running init, change `backend.tf` to a different account/bucket/key and bootstrap that private bucket. The checked-in backend targets production: a separate directory alone does not isolate state.** Preserve current production state; do not repoint it at a new account. The resource names default to `embyfin`, `embyfin-posters` and `embyfin-backups`, so this configuration is for one installation per account.
2. Establish the account/plan/zone/team prerequisites from the runbook. Configure one-time PIN in the new team and read its provider ID under **Zero Trust → Integrations → Identity providers**. Reusing the existing provider does not grant Terraform ownership of it.
3. Set the new account, hostname, owner, team and login method in tfvars, with **`adopt_existing=false`**. Verify original source credentials and the base Wrangler source settings. Terraform creates an empty catalog and two derived buckets; it does not duplicate originals.
4. Initialize, validate, plan, review, then apply. A fresh installation should plan nine resources and no imports. Generate `wrangler.terraform.json` from the applied outputs.
5. For an intentionally empty catalog, apply the initial migration using the generated config. For a recovery, restore and reconcile state as described below instead of running schema creation over imported SQL.

   ```sh
   unset CLOUDFLARE_API_TOKEN
   ./node_modules/.bin/wrangler d1 migrations apply DB --remote --config wrangler.terraform.json
   ```

6. Deploy with the four runtime secrets, verify Access and source connection, then create/scan approved libraries. See [first deployment](../../docs/CLOUDFLARE-RUNBOOK.md#first-deployment-or-replacement-infrastructure).

## Recovery when Terraform owns D1

Follow [RECOVERY.md](../../docs/RECOVERY.md) to create and verify an isolated restored database while production is in maintenance. Before generating a new Wrangler config for cutover, reconcile Terraform to that **verified** database:

1. Securely back up the current Terraform state. Set `database_name` to the restored database's actual name and update the catalog import ID in `imports.tf` to its new UUID.
2. With the Terraform operator credential loaded, remove only the old catalog's **state association** and import the restored database. Replace the example IDs below with the verified account/database. `state rm` does not delete the old Cloudflare database; retain it until recovery is accepted.

   ```sh
   terraform -chdir=infra/terraform state rm cloudflare_d1_database.catalog
   terraform -chdir=infra/terraform import cloudflare_d1_database.catalog 'ACCOUNT_ID/VERIFIED_RESTORED_DATABASE_ID'
   terraform -chdir=infra/terraform plan
   ```

3. Stop if the plan would recreate, rename or delete the restored database. Resolve configuration/state differences first. Refresh applied outputs with a reviewed plan before generating `wrangler.terraform.json`, then deploy while maintenance remains on. Continue the recovery runbook's identity/grant checks and reopening steps.

Without this reconciliation, a later generated config could point the Worker or backups back to the old database. Neither an infrastructure apply nor a Worker rollback restores data.

## Verification recorded for this addition

`terraform fmt -check`, provider-backed `terraform validate`, and `terraform test` with a mocked Cloudflare provider verify syntax/schema, owner-only browser policy, machine destination, private development URLs, generated owner/team/origin, absence of runtime secrets in generated vars, and rejection of imports into another account. Tests use plan mode and make no Cloudflare calls. Live adoption also verified the existing database/AUD values and owner/machine policy attachments:

```sh
terraform -chdir=infra/terraform test
```

On restricted hosts the Terraform provider needs permission to open its local plugin socket even for validation. Terraform 1.10.2 and provider 5.24.0 were used for the checks. **Live adoption completed on 2026-09-11: seven resources imported, two disabled R2 development URL settings added, zero existing resources changed or destroyed.** The follow-up live plan returned exit code 0 and “No changes.” All nine managed instances were adopted locally, then migrated to the remote backend described above. The current local recovery copy is `.wrangler/terraform-remote.tfstate.backup`. Generated root `wrangler.terraform.json` exactly matches the base production configuration, including database IDs and browser AUD; no Worker redeployment was necessary. The approved `embyfin-terraform` account token is stored in ignored `.wrangler/terraform.env` (mode 0600), separately from Worker secrets; its dashboard expiry is **December 11, 2026**. Rotate it before expiry and preserve it in the operator vault. Remote R2 state migration is complete; an independently encrypted off-workstation recovery backup remains pending the destination and recovery-key vault.

The adoption plan matched API defaults explicitly: disabled D1 read replication, empty policy RDP connection rules, and existing Access cookie/preflight settings. Disabled browser WARP/path-cookie options are omitted because the API returns them absent. The processor app retains its existing HTTPOnly=false setting; the owner browser app retains HTTPOnly=true. No access rule was broadened.
